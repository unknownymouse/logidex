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
import { BrowserWindow } from 'electron'

export const FLOW_ORIGIN = 'https://labs.google'
export const FLOW_ROUTE = '/fx/tools/flow'
const FLOW_URL = `${FLOW_ORIGIN}${FLOW_ROUTE}`
const PARTITION = 'persist:flow-bridge'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const HARVEST_POLL_MS = 1500

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
}

export interface FlowSessionStatus {
  open: boolean
  loggedIn: boolean
}

let win: BrowserWindow | null = null
let loadPromise: Promise<void> | null = null
let loginPromise: Promise<{ ok: boolean; message: string }> | null = null

function debug(...args: unknown[]): void {
  if (process.env.FLOW_DEBUG) console.log('[flow-bridge]', ...args)
}

function getWindow(show: boolean): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (show && !win.isVisible()) win.show()
    return win
  }
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    show,
    title: 'Masuk ke Google Flow',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.on('closed', () => {
    win = null
    loadPromise = null
  })
  return win
}

function waitForLoad(target: BrowserWindow, timeoutMs = 45000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!target.webContents.isLoading()) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Halaman Flow tidak selesai dimuat'))
    }, timeoutMs)
    const done = (): void => {
      cleanup()
      resolve()
    }
    const fail = (_e: unknown, code: number, desc: string): void => {
      cleanup()
      reject(new Error(`Gagal memuat Flow (${code} ${desc})`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      target.webContents.off('did-finish-load', done)
      target.webContents.off('did-fail-load', fail)
    }
    target.webContents.once('did-finish-load', done)
    target.webContents.once('did-fail-load', fail)
  })
}

/** Navigate the hidden window to Flow and wait for the document to settle. */
async function ensureFlowLoaded(show: boolean): Promise<BrowserWindow> {
  const target = getWindow(show)
  const current = target.webContents.getURL()
  if (current.startsWith(FLOW_ORIGIN)) {
    if (show && !target.isVisible()) target.show()
    return target
  }
  if (!loadPromise) {
    loadPromise = target.loadURL(FLOW_URL).catch((e: unknown) => {
      loadPromise = null
      throw e
    })
  }
  await loadPromise
  await waitForLoad(target)
  return target
}

/**
 * Runs inside the page. Finds `WIZ_global_data`, derives the per-session scalars, posts the
 * batchexecute request with same-origin credentials, then unpacks the anti-XSSI envelope.
 */
function rpcScript(rpcId: string, argsJson: string, sourcePath: string): string {
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
    return JSON.stringify({ ok: false, status: 0, payloads: [], raw: '',
      stage: 'wiz', error: 'WIZ_global_data tidak ketemu - halaman Flow belum termuat atau belum login' })
  }

  const strs = Object.values(wiz).filter((v) => typeof v === 'string')
  const sid = strs.find((v) => /^\\d{15,25}$/.test(v)) || ''
  const bl = strs.find((v) => v.startsWith('boq_')) || ''
  const base = typeof wiz.eptZe === 'string' ? wiz.eptZe : '/_/AiSandboxAngularFrontend/'
  if (!sid) {
    return JSON.stringify({ ok: false, status: 0, payloads: [], raw: '',
      stage: 'login', error: 'Sesi Flow belum aktif - silakan login di jendela ini' })
  }

  const qs = new URLSearchParams({
    rpcids: RPC_ID,
    'source-path': SOURCE || location.pathname,
    'f.sid': sid,
    bl: bl,
    hl: 'en',
    'soc-app': '1',
    'soc-platform': '1',
    'soc-device': '1',
    rt: 'c',
    _reqid: String(100000 + Math.floor(Math.random() * 899999))
  })
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[[RPC_ID, ARGS, null, 'generic']]]))

  let res, text
  try {
    res = await fetch(base + 'data/batchexecute?' + qs.toString(), {
      method: 'POST',
      credentials: 'include',
      body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    })
    text = await res.text()
  } catch (e) {
    return JSON.stringify({ ok: false, status: 0, payloads: [], raw: '',
      stage: 'fetch', error: String(e) })
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

  return JSON.stringify({ ok: res.ok, status: res.status, payloads: payloads, raw: text.slice(0, 4000) })
})()`
}

/** Execute one batchexecute RPC through the logged-in Flow page. */
export async function callFlowRpc(
  rpcId: string,
  args: unknown,
  sourcePath = FLOW_ROUTE
): Promise<FlowRpcResult> {
  const target = await ensureFlowLoaded(false)
  const script = rpcScript(rpcId, JSON.stringify(args ?? []), sourcePath)
  const raw = (await target.webContents.executeJavaScript(script, true)) as string
  let parsed: FlowRpcResult
  try {
    parsed = JSON.parse(raw) as FlowRpcResult
  } catch {
    return { ok: false, status: 0, payloads: [], raw: String(raw).slice(0, 4000), stage: 'parse', error: 'Respons bukan JSON' }
  }
  debug(rpcId, '->', parsed.status, parsed.stage ?? '', parsed.error ?? '')
  if (process.env.FLOW_DEBUG) console.log('[flow-bridge] raw:', parsed.raw)
  return parsed
}

/** True once the page exposes a usable session (used before deciding to prompt for login). */
export async function getFlowSessionStatus(): Promise<FlowSessionStatus> {
  if (!win || win.isDestroyed()) return { open: false, loggedIn: false }
  try {
    const res = await callFlowRpc('nzlxg', [], FLOW_ROUTE)
    return { open: true, loggedIn: res.ok || !(res.stage === 'login' || res.stage === 'wiz') }
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
    loadPromise = null
    await ensureFlowLoaded(true)

    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    let last = ''
    while (Date.now() < deadline) {
      const res = await callFlowRpc('nzlxg', [], FLOW_ROUTE)
      if (res.stage === 'wiz' || res.stage === 'login') {
        last = res.error ?? ''
      } else {
        target.hide()
        return { ok: true, message: 'Google Flow terhubung' }
      }
      await new Promise((r) => setTimeout(r, HARVEST_POLL_MS))
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
