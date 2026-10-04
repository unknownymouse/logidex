/**
 * Flow cookie bridge — the one thing an OAuth token cannot do.
 *
 * Recovered scalars (docs/flow-api-re.md §6):
 *   endpoint  = https://labs.google/_/AiSandboxAngularFrontend/data/batchexecute
 *   body      = f.req=[[[<rpcId>,<argsJson>,null,"generic"]]]
 *   auth      = cookies (+ SAPISIDHASH, which the page adds for us)
 *
 * `eptZe` (base path), `cfb2h` (build label) and `FdrFJe` (f.sid) are per-session values, so
 * they are harvested from the live page instead of hardcoded — hardcoding them is how a
 * bridge rots two weeks later.
 *
 * The request runs *inside* the loaded page so same-origin cookies, the Origin header and the
 * framework XSRF token all behave exactly as they do for the real web client. We never
 * hand-roll SAPISIDHASH, and we never need the `at` token (this build does not use one).
 */
import { app, BrowserWindow, session } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TimeoutError, withTimeout } from './timeout'

export const FLOW_ORIGIN = 'https://labs.google'
export const FLOW_ROUTE = '/fx/tools/flow'
const FLOW_URL = `${FLOW_ORIGIN}${FLOW_ROUTE}`
const PARTITION = 'persist:flow-bridge'
const HARVEST_POLL_MS = 1500
/**
 * How long the human gets, once the window is in front of them. Long enough for a password plus a
 * 2FA prompt on a second device, short enough that a walk-away ends in a message instead of a
 * spinner that runs all evening.
 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
/** How long to wait for *a document*, not for the network to go quiet — see waitForDocument. */
const FLOW_READY_TIMEOUT_MS = 60000
const READY_POLL_MS = 500
/** A page script that never settles must not hang a job — see execInPage. */
const PAGE_PROBE_TIMEOUT_MS = 20_000
const PAGE_RPC_TIMEOUT_MS = 180_000
const PAGE_DOWNLOAD_TIMEOUT_MS = 180_000
/**
 * In-page fetch deadline. Deliberately *below* the executeJavaScript deadline so the page gives up
 * first: the failure then arrives as a readable result instead of a dead call we can only time out.
 */
const RPC_FETCH_TIMEOUT_MS = 150_000
/** The always-on bridge log rolls over at this size. */
const LOG_MAX_BYTES = 256 * 1024
/**
 * Google walls its sign-in off inside clients it recognises as embedded ("this browser or app may
 * not be secure"). The bridge really is Chromium, so present it as one; `FLOW_UA=default` restores
 * Electron's own user agent for debugging.
 */
const FLOW_UA =
  process.env.FLOW_UA === 'default'
    ? ''
    : process.env.FLOW_UA ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface FlowRpcResult {
  ok: boolean
  status: number
  /** Parsed `wrb.fr` payloads for the requested rpc id. */
  payloads: unknown[]
  /** First 4 kB of the raw response — the honest error surface. */
  raw: string
  /** Set when the failure happened before the request left the page. */
  stage?: string
  error?: string
  xsrf?: string
}

export interface FlowSessionStatus {
  open: boolean
  loggedIn: boolean
}

let win: BrowserWindow | null = null
let loadPromise: Promise<void> | null = null
let loginPromise: Promise<{ ok: boolean; message: string }> | null = null

let logPath: string | null = null

/**
 * The most recent `xsrf` token a batchexecute response handed back. Google rotates the
 * anti-XSRF token per response, so the freshest one wins on the next call.
 */
let cachedAt = ''

/**
 * Always-on log file, next to the app's database.
 *
 * FLOW_DEBUG only reaches a console nobody is watching on the user's machine, so a failed run used
 * to leave no evidence at all. This file is written unconditionally (and rolls over) so "it just
 * sits there" can be answered with a file instead of another round of guessing.
 */
export function getBridgeLogPath(): string {
  if (logPath !== null) return logPath
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'flow-bridge.log')
  } catch {
    logPath = ''
  }
  return logPath
}

/**
 * JSON for the log, with long strings (the base64 image body) collapsed to their length, so a
 * diagnostic dump stays readable instead of growing the log by megabytes.
 */
function redactArgs(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v
    ).slice(0, 2000)
  } catch {
    return '<tidak bisa diserialisasi>'
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function debug(...args: unknown[]): void {
  if (process.env.FLOW_DEBUG) console.log('[flow-bridge]', ...args)
  try {
    const file = getBridgeLogPath()
    if (!file) return
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      /* no log yet */
    }
    const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}\n`
    appendFileSync(file, line)
  } catch {
    /* logging must never break the bridge */
  }
}

function getWindow(show: boolean): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (show && !win.isVisible()) win.show()
    return win
  }
  const created = new BrowserWindow({
    width: 1120,
    height: 820,
    show,
    title: 'Masuk ke Google Flow',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The generate path never shows this window. Without this, Chromium throttles a hidden
      // renderer's timers, which stalls the very request the bridge is waiting on.
      backgroundThrottling: false
    }
  })
  win = created
  if (FLOW_UA) session.fromPartition(PARTITION).setUserAgent(FLOW_UA)
  // Google sometimes opens its account chooser in a popup; keep the whole sign-in inside the one
  // window whose partition holds the session.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(accounts\.google\.com|labs\.google)/.test(url)) void created.loadURL(url)
    return { action: 'deny' }
  })
  created.on('closed', () => {
    win = null
    loadPromise = null
  })
  return created
}

/** Runs inside the page: enough state to tell whether a usable document exists. */
function probeScript(): string {
  return `(() => {
  function findWiz() {
    const direct = window.WIZ_global_data
    if (direct && typeof direct.eptZe === 'string') return direct
    for (const k of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[k]
        if (v && typeof v === 'object' && typeof v.eptZe === 'string') return v
      } catch (e) {}
    }
    return null
  }
  const body = document.body
  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    hasWiz: !!findWiz(),
    nodes: body ? body.childElementCount : 0,
    text: body && body.innerText ? body.innerText.slice(0, 200) : ''
  })
})()`
}

interface FlowPageProbe {
  url: string
  title: string
  readyState: string
  hasWiz: boolean
  nodes: number
  text: string
}

async function probe(target: BrowserWindow): Promise<FlowPageProbe | null> {
  if (target.isDestroyed()) return null
  try {
    const raw = await execInPage(target, probeScript(), PAGE_PROBE_TIMEOUT_MS, 'Membaca halaman Flow')
    return JSON.parse(raw) as FlowPageProbe
  } catch {
    return null
  }
}

function describeProbe(p: FlowPageProbe | null): string {
  if (!p) return 'dokumen tidak terbaca'
  const text = p.text.replace(/\s+/g, ' ').trim().slice(0, 80)
  return `url=${p.url} title="${p.title}" ready=${p.readyState} nodes=${p.nodes} wiz=${p.hasWiz} teks="${text}"`
}

/**
 * Wait until the window holds a *rendered document*, not until the network goes quiet.
 *
 * The old `did-finish-load` + `isLoading()` pair was wrong for this site: labs.google hands off to
 * Google's sign-in with a client-side redirect, after which the page sits with `isLoading() ===
 * true` while a subresource hangs — so the wait burned its whole timeout on a page that was
 * already usable. Any document counts as ready, including a sign-in page: the *caller* decides
 * whether the session behind it is usable, not this function.
 */
async function waitForDocument(target: BrowserWindow, timeoutMs = FLOW_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: FlowPageProbe | null = null
  while (Date.now() < deadline) {
    if (target.isDestroyed()) throw new Error('Jendela Flow ditutup sebelum halaman siap')
    last = await probe(target)
    // `loading` = the document is still being parsed; `interactive`/`complete` means the DOM is
    // there and scriptable even when a subresource is still pending.
    if (last && last.nodes > 0 && last.readyState !== 'loading' && last.url !== 'about:blank') {
      debug('dokumen siap:', describeProbe(last))
      return
    }
    await delay(READY_POLL_MS)
  }
  throw new Error(`Halaman Flow tidak selesai dimuat (${describeProbe(last)})`)
}

/**
 * Run a page script under a deadline.
 *
 * `executeJavaScript` settles only when the page's script settles. A stalled `fetch` inside that
 * script — or a renderer that never becomes responsive — leaves the promise pending forever, and
 * no deadline the caller wrapped around *other* work is ever re-evaluated. That single unbounded
 * await is what turned a failed upload into an endless "10%" spinner with no error to report.
 */
async function execInPage(target: BrowserWindow, script: string, timeoutMs: number, label: string): Promise<string> {
  const raw = await withTimeout(
    target.webContents.executeJavaScript(script, true) as Promise<unknown>,
    timeoutMs,
    label
  )
  return typeof raw === 'string' ? raw : safeJson(raw ?? null)
}

/** Navigate the bridge window to Flow once, tolerating the redirect chain Google throws at it. */
function loadFlow(target: BrowserWindow): Promise<void> {
  // Sign-in bounces through several URLs and Electron surfaces an intermediate abort as a
  // rejection even though the final page arrives. Readiness is decided by waitForDocument, so a
  // rejected navigation must not abort the attempt.
  return target
    .loadURL(FLOW_URL)
    .then(() => undefined)
    .catch((e: unknown) => {
      debug('loadURL ditolak, lanjut menunggu dokumen:', String(e))
    })
}

/** Make sure the bridge window holds a usable document, navigating only when it has none. */
async function ensureFlowLoaded(show: boolean): Promise<BrowserWindow> {
  const target = getWindow(show)
  if (show && !target.isVisible()) {
    target.show()
    target.focus()
  }
  // Re-navigating whenever the URL was not on labs.google used to fight the SPA's own redirect
  // into Google sign-in and reload the page under the user's feet. Any document is scriptable, so
  // only an empty window triggers a navigation.
  const existing = await probe(target)
  if (existing && existing.nodes > 0 && existing.readyState !== 'loading') {
    debug('memakai halaman yang sudah termuat:', existing.url, 'wiz=' + existing.hasWiz)
    return target
  }
  if (!loadPromise) {
    loadPromise = loadFlow(target).finally(() => {
      loadPromise = null
    })
  }
  await loadPromise
  await waitForDocument(target)
  return target
}

/**
 * Runs inside the page. Finds `WIZ_global_data`, derives the per-session scalars, posts the
 * batchexecute request with same-origin credentials, then unpacks the anti-XSSI envelope.
 */
function rpcScript(rpcId: string, argsJson: string, sourcePath: string, atOverride = ''): string {
  return `(async () => {
  const RPC_ID = ${JSON.stringify(rpcId)}
  const ARGS = ${JSON.stringify(argsJson)}
  const SOURCE = ${JSON.stringify(sourcePath)}

  function findWiz() {
    const direct = window.WIZ_global_data
    if (direct && typeof direct.eptZe === 'string') return direct
    for (const k of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[k]
        if (v && typeof v === 'object' && typeof v.eptZe === 'string') return v
      } catch (e) {}
    }
    return null
  }

  const wiz = findWiz()
  if (!wiz) {
    const where = location.href + ' (ready=' + document.readyState + ') "' + (document.title || '') + '"'
    return JSON.stringify({ ok: false, status: 0, payloads: [], raw: '',
      stage: 'wiz', error: 'WIZ_global_data tidak ketemu di ' + where })
  }

  const strs = Object.values(wiz).filter((v) => typeof v === 'string')
  // Canonical WIZ_global_data keys for the boq handshake: FdrFje is f.sid, cfb2h is bl. The
  // regex guesses below only cover a page that renamed them.
  const at0 = typeof wiz.SNlM0e === 'string' ? wiz.SNlM0e : ''
  const sid = (typeof wiz.FdrFje === 'string' && wiz.FdrFje) || strs.find((v) => /^\\d{15,25}$/.test(v)) || ''
  const bl = (typeof wiz.cfb2h === 'string' && wiz.cfb2h) || strs.find((v) => v.startsWith('boq_')) || ''
  const base = typeof wiz.eptZe === 'string' ? wiz.eptZe : '/_/AiSandboxAngularFrontend/'
  const AT_OVERRIDE = ${JSON.stringify(atOverride)}

  const qs = new URLSearchParams({
    rpcids: RPC_ID,
    'source-path': SOURCE || location.pathname,
    bl: bl,
    hl: 'en',
    'soc-app': '1',
    'soc-platform': '1',
    'soc-device': '1',
    rt: 'c',
    _reqid: String(100000 + Math.floor(Math.random() * 899999))
  })
  // f.sid is per-session bookkeeping, not authentication: send it when the page exposes it,
  // but never refuse the call without it. Cookies carry the auth.
  if (sid) qs.set('f.sid', sid)

  // The at param is the anti-XSRF token every POST to batchexecute needs. The Flow bundle
  // installs it with configure(xd('SNlM0e'), xd('S06Grb')) - i.e. WIZ_global_data.SNlM0e - and
  // omitting it is what makes mutating RPCs (uploads) answer HTTP 400 while reads look fine.
  // A token the server handed back in an earlier response (xsrf) is the fallback.
  const at = AT_OVERRIDE || at0
  if (at) qs.set('at', at)

  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[[RPC_ID, ARGS, null, 'generic']]]))

  // Without a deadline this request can hang on a stalled socket — a multi-megabyte image body, a
  // connection that is never closed — and the executeJavaScript call around it hangs with it.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ${RPC_FETCH_TIMEOUT_MS})
  let res, text
  try {
    res = await fetch(base + 'data/batchexecute?' + qs.toString(), {
      method: 'POST',
      credentials: 'include',
      body: body,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    })
    text = await res.text()
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, payloads: [], raw: '',
      stage: 'fetch', error: String(e) })
  } finally {
    clearTimeout(timer)
  }

  // A missing f.sid alone is not proof of a logged-out session, but a 401/403 or a login page
  // in the body is: that is what the caller uses to decide whether to ask the human to sign in.
  if (!sid && (res.status === 401 || res.status === 403 || /accounts\\.google\\.com|ServiceLogin/.test(text))) {
    return JSON.stringify({ ok: false, status: res.status, payloads: [], raw: text.slice(0, 2000),
      stage: 'login', error: 'Sesi Flow belum aktif - silakan login di jendela ini' })
  }

  const payloads = []
  for (const line of text.split('\\n')) {
    const t = line.trim()
    if (!t || t.startsWith(')]}') || /^\\d+$/.test(t)) continue
    let chunk
    try { chunk = JSON.parse(t) } catch (e) { continue }
    if (!Array.isArray(chunk)) continue
    for (const item of chunk) {
      if (Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === RPC_ID && item[2] != null) {
        try { payloads.push(JSON.parse(item[2])) } catch (e) { payloads.push(item[2]) }
      }
    }
  }

  const xsrf = (/"xsrf"\\s*:\\s*"([^"]+)"/.exec(text) || [])[1] || ''
  return JSON.stringify({ ok: res.ok, status: res.status, payloads: payloads, raw: text.slice(0, 4000), xsrf: xsrf })
})()`
}

/** Which wire shape the RPC arguments take. See `toPositionalArgs`. */
export type FlowArgStyle = 'object' | 'array'

/**
 * boq serialises a request with `JSON.stringify(msg.toObject())`, i.e. a plain object keyed by
 * the *field number as a string* (`{"1":…,"3":…}`) — that is the form the bundle produces
 * (`XC(transport,"f.req", request.je())`). Older batchexecute builds accept the positional
 * array form instead, so this converts one to the other and `callFlowRpcAuto` tries both.
 */
export function toPositionalArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPositionalArgs)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    let max = 0
    for (const key of Object.keys(obj)) {
      const n = Number(key)
      if (Number.isInteger(n) && n > max) max = n
    }
    if (!max) return {}
    const out: unknown[] = []
    for (let i = 1; i <= max; i += 1) {
      const v = obj[String(i)]
      out.push(v === undefined ? null : toPositionalArgs(v))
    }
    return out
  }
  return value
}

/** Execute one batchexecute RPC through the logged-in Flow page. */
export async function callFlowRpc(
  rpcId: string,
  args: unknown,
  sourcePath = FLOW_ROUTE,
  opts: { argStyle?: FlowArgStyle } = {}
): Promise<FlowRpcResult> {
  const payload = opts.argStyle === 'array' ? toPositionalArgs(args) : args
  const script = rpcScript(rpcId, JSON.stringify(payload ?? []), sourcePath, cachedAt)

  const attempt = async (): Promise<string> => {
    const target = await ensureFlowLoaded(false)
    return execInPage(target, script, PAGE_RPC_TIMEOUT_MS, `RPC ${rpcId}`)
  }

  let raw: string
  try {
    raw = await attempt()
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e
    // The page is wedged or the request stalled. A reload keeps the partition cookies and gives the
    // renderer a clean slate, so retry once before reporting — then report honestly.
    debug(rpcId, 'timeout:', e.message, '-> reload halaman lalu coba sekali lagi')
    const target = getWindow(false)
    if (target.isDestroyed()) {
      return { ok: false, status: 0, payloads: [], raw: '', stage: 'timeout', error: e.message }
    }
    try {
      await target.webContents.reload()
      loadPromise = null
      raw = await attempt()
    } catch (retry) {
      const message = retry instanceof Error ? retry.message : String(retry)
      debug(rpcId, 'percobaan ulang gagal:', message)
      return { ok: false, status: 0, payloads: [], raw: '', stage: 'timeout', error: message }
    }
  }

  let parsed: FlowRpcResult
  try {
    parsed = JSON.parse(raw) as FlowRpcResult
  } catch {
    return { ok: false, status: 0, payloads: [], raw: String(raw).slice(0, 4000), stage: 'parse', error: 'Respons bukan JSON' }
  }
  if (parsed.xsrf) cachedAt = parsed.xsrf
  debug(rpcId, '->', parsed.status, parsed.stage ?? '', parsed.error ?? '')
  if (!parsed.ok) {
    // The reason this log exists: a rejected RPC must say what it sent and what came back, in
    // one file, with no debug flag set on the user's machine.
    debug(rpcId, 'GAGAL request:', redactArgs(payload))
    debug(rpcId, 'GAGAL respons:', String(parsed.raw ?? '').slice(0, 2500))
  }
  if (process.env.FLOW_DEBUG) console.log('[flow-bridge] raw:', parsed.raw)
  return parsed
}

/**
 * Run an RPC with the proto-JSON object form, falling back to the positional array form when the
 * server answers 200 with an empty body (a marshal-level rejection leaves no `wrb.fr` payload).
 * Costs at most one extra request, and pins the wire shape on the first live run.
 */
export async function callFlowRpcAuto(
  rpcId: string,
  args: unknown,
  sourcePath = FLOW_ROUTE
): Promise<FlowRpcResult> {
  const objectForm = await callFlowRpc(rpcId, args, sourcePath, { argStyle: 'object' })
  if (objectForm.stage || !objectForm.ok || objectForm.payloads.length > 0) return objectForm
  debug(rpcId, 'object form returned no payload; retrying positional array form')
  const arrayForm = await callFlowRpc(rpcId, args, sourcePath, { argStyle: 'array' })
  return arrayForm.payloads.length > 0 ? arrayForm : objectForm
}

/** Runs inside the page: fetch a Fife/media URL with the session cookies and hand back base64. */
function downloadScript(url: string): string {
  return `(async () => {
  const url = ${JSON.stringify(url)}
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ${RPC_FETCH_TIMEOUT_MS})
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctrl.signal })
    if (!res.ok) return JSON.stringify({ ok: false, status: res.status, error: 'HTTP ' + res.status })
    const bytes = new Uint8Array(await res.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return JSON.stringify({ ok: true, status: res.status,
      contentType: res.headers.get('content-type') || '', base64: btoa(bin) })
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, error: String(e) })
  } finally {
    clearTimeout(timer)
  }
})()`
}

export interface FlowDownloadResult {
  ok: boolean
  status: number
  contentType?: string
  bytes?: Buffer
  error?: string
}

/**
 * Download a produced video through the session. Flow's media URLs (Fife) are cookie-scoped, so
 * the fetch has to happen inside the page rather than in the main process.
 */
export async function downloadFlowMedia(url: string): Promise<FlowDownloadResult> {
  const target = await ensureFlowLoaded(false)
  let raw: string
  try {
    raw = await execInPage(target, downloadScript(url), PAGE_DOWNLOAD_TIMEOUT_MS, 'Mengunduh media Flow')
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    const parsed = JSON.parse(raw) as { ok: boolean; status: number; contentType?: string; base64?: string; error?: string }
    if (!parsed.ok || !parsed.base64) {
      return { ok: false, status: parsed.status ?? 0, error: parsed.error ?? 'unduhan kosong' }
    }
    return {
      ok: true,
      status: parsed.status,
      contentType: parsed.contentType,
      bytes: Buffer.from(parsed.base64, 'base64')
    }
  } catch {
    return { ok: false, status: 0, error: 'Respons unduhan bukan JSON' }
  }
}

/** True once the page exposes a usable session (used before deciding to prompt for login). */
export async function getFlowSessionStatus(): Promise<FlowSessionStatus> {
  if (!win || win.isDestroyed()) return { open: false, loggedIn: false }
  try {
    const res = await callFlowRpc('nzlxg', [], FLOW_ROUTE)
    // Only a definite answer counts as a live session. The old `!(login || wiz)` test reported a
    // stalled page ('timeout'/'fetch') as logged in, which skipped the sign-in prompt the user
    // actually needed — and the job then died much later with a far less useful message.
    const unusable =
      res.stage === 'wiz' || res.stage === 'login' || res.stage === 'timeout' || res.stage === 'fetch'
    return { open: true, loggedIn: !unusable }
  } catch {
    return { open: true, loggedIn: false }
  }
}

/**
 * Show the window and wait for the user to finish logging into Google. Resolves as soon as the
 * Flow page exposes a session, so the caller can carry on with the job the user asked for.
 */
export async function openFlowLogin(): Promise<{ ok: boolean; message: string }> {
  if (loginPromise) return loginPromise

  loginPromise = (async () => {
    const target = getWindow(true)
    target.show()
    target.focus()
    await ensureFlowLoaded(true)

    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    let last = ''
    while (Date.now() < deadline) {
      let res: FlowRpcResult | null = null
      try {
        res = await callFlowRpc('nzlxg', [], FLOW_ROUTE)
      } catch (e) {
        // A throw here used to end the whole login wait. Keep waiting: the user may still be typing.
        last = e instanceof Error ? e.message : String(e)
        debug('cek sesi gagal:', last)
      }
      if (res && res.stage !== 'wiz' && res.stage !== 'login' && res.stage !== 'timeout' && res.stage !== 'fetch') {
        target.hide()
        return { ok: true, message: 'Google Flow terhubung' }
      }
      if (res) {
        last = res.error ?? ''
        if (res.stage === 'timeout') {
          // The user is looking straight at this window; hand them a fresh page, not a wedge.
          debug('halaman tidak merespons saat menunggu login, reload')
          try {
            await target.webContents.reload()
          } catch {
            /* the window may be closing */
          }
        }
      }
      await delay(HARVEST_POLL_MS)
    }
    return {
      ok: false,
      message: last
        ? `Belum berhasil masuk ke Google Flow: ${last}`
        : 'Waktu login habis. Coba lagi bila sudah masuk ke akun Google.'
    }
  })()

  try {
    return await loginPromise
  } finally {
    loginPromise = null
  }
}

/** Drop the bridge session (keeps the persisted partition cookies — use closeFlowWindow for that). */
export function closeFlowSession(): void {
  if (win && !win.isDestroyed()) win.hide()
}

/** Fully forget the Flow login (clears the partition cookies). */
export async function forgetFlowSession(): Promise<void> {
  if (win && !win.isDestroyed()) {
    await win.webContents.session.clearStorageData({ storages: ['cookies'] })
    win.destroy()
    win = null
    loadPromise = null
  }
}
