/**
 * Google Flow video generation client (reverse-engineered 2026-10-03).
 *
 * Background
 * ----------
 * The app previously refused to generate video with a Google OAuth login because
 * `cloudcode-pa.googleapis.com` (the Antigravity / Gemini-Code-Assist backend) only
 * speaks LLM requests. That assumption was wrong for two reasons:
 *
 *  1. The OAuth client used by this app (the Google first-party client that backs
 *     Gemini CLI / Antigravity) is granted `https://www.googleapis.com/auth/cloud-platform`,
 *     which is accepted by Google's *Lab* APIs too.
 *  2. Google Flow's own backend `aisandbox-pa.googleapis.com` exposes a REST surface
 *     under `/v1/` that authenticates with **OAuth 2 access tokens** (or the login
 *     cookie). Verified by probing the live host:
 *
 *       POST /v1/video:batchAsyncGenerateVideoText            -> 401 "missing required
 *                                                                 authentication credential"
 *       POST /v1/video:batchAsyncGenerateVideoStartAndEndImage-> 401 (exists)
 *       POST /v1/video:batchAsyncGenerateVideoExtendVideo     -> 401 (exists)
 *       POST /v1/video:batchAsyncGenerateVideoReferenceImages -> 401 (exists)
 *       POST /v1/video:batchAsyncGenerateVideoUpsampleVideo   -> 401 (exists)
 *       POST /v1/video:batchCheckAsyncVideoGenerationStatus   -> 401 (exists)
 *       GET  /v1/credits                                      -> 401 (exists)
 *       POST /v1/video:batchAsyncGenerateVideo                -> 404 (does not exist)
 *
 *     With a syntactically valid but bogus bearer token the same endpoints answer
 *     "Request had **invalid** authentication credentials. Expected OAuth 2 access
 *     token, login cookie or other valid authentication credential", which proves the
 *     `Authorization: Bearer <oauth_token>` scheme is parsed and honoured — only the
 *     token itself was unknown to the server.
 *
 * Enum / field names below were extracted from the production Flow bundle
 * (`boq_labs-ai-sandbox-frontend_20261002.00_p0`), which is also where the
 * `VideoFxService` RPC ids (`IJhj9c`, `nzlxg`, `Iyc41d`, ...) and the aspect-ratio
 * enum family `VIDEO_ASPECT_RATIO_{LANDSCAPE,PORTRAIT}` come from.
 *
 * Everything here is best-effort against a private API: the request envelope is
 * centralised in `buildGenerateRequest()` so it can be tuned in one place if Google
 * changes the schema. Set `FLOW_DEBUG=1` to dump every request/response.
 */

const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com/v1'

export type FlowAspectRatio =
  | 'VIDEO_ASPECT_RATIO_LANDSCAPE'
  | 'VIDEO_ASPECT_RATIO_PORTRAIT'
  | 'VIDEO_ASPECT_RATIO_SQUARE'

export interface FlowGenerationParams {
  prompt: string
  /** Flow wire model key, e.g. `veo_3_1_t2v_fast`. */
  modelKey?: string
  aspectRatio?: FlowAspectRatio
  seed?: number
  /** Flow project scene id (`ve`); optional but improves bookkeeping. */
  sceneId?: string
  /** Optional first/last frame media ids produced by Flow's upload endpoint. */
  firstFrameMediaId?: string
  lastFrameMediaId?: string
}

export interface FlowOperation {
  name: string
}

export interface FlowStatusItem {
  name?: string
  status?: string
  done?: boolean
  error?: unknown
  /** Any downloadable media URL found in the payload (Fife / content URL). */
  url?: string
  /** Some responses inline the video as base64. */
  base64?: string
}

const DEFAULT_MODEL_KEY = 'veo_3_1_t2v_fast'

function log(...args: unknown[]): void {
  if (process.env.FLOW_DEBUG) console.error('[flow]', ...args)
}

function randomSessionId(): string {
  // Flow's clientContext.sessionId is a plain 31-bit integer sent as a string.
  return String(Math.floor(Math.random() * 2147483647))
}

function aspectFor(aspect?: FlowAspectRatio): FlowAspectRatio {
  return aspect || 'VIDEO_ASPECT_RATIO_LANDSCAPE'
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Origin: 'https://labs.google',
    Referer: 'https://labs.google/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'X-Goog-Api-Client': 'gl-js/ flow/1.0'
  }
}

async function call(
  token: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
  method: 'POST' | 'GET' = 'POST'
): Promise<unknown> {
  const url = `${FLOW_API_BASE}${path}`
  log(method, url, JSON.stringify(body))
  const res = await fetch(url, {
    method,
    headers: headers(token),
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal
  })
  const text = await res.text()
  log('<-', res.status, text.slice(0, 2000))
  if (!res.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } }
      detail = parsed?.error?.message || parsed?.error?.status || text
    } catch {
      /* keep raw text */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Google Flow menolak kredensial (HTTP ${res.status}): ${detail}. ` +
          'Jalur OAuth REST ini hanya menerima token dengan scope khusus API Labs Google: token ' +
          'OAuth Antigravity/Gemini (scope cloud-platform) dijawab "insufficient authentication ' +
          'scopes" bahkan setelah login ulang. Generate video karena itu dijalankan lewat sesi ' +
          'login Flow (cookie bridge) - pastikan jendela Flow sudah login ke akun yang punya ' +
          'akses labs.google/fx/tools/flow.'
      )
    }
    throw new Error(`Google Flow error (HTTP ${res.status}): ${detail}`)
  }
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

/** Account credit balance — cheapest way to prove the token can reach Flow. */
export async function getCredits(token: string, signal?: AbortSignal): Promise<unknown> {
  return call(token, '/credits', undefined, signal, 'GET')
}

/**
 * Flow's request envelope. Extracted from the production bundle:
 *   item field 1  -> prompt
 *   item field 2  -> videoModelKey
 *   item field 5  -> metadata { sceneId, workflowId, seed }
 *   item field 12 -> aspectRatio (VIDEO_ASPECT_RATIO_*)
 *   batch        -> clientContext { sessionId, tool: "PINHOLE" }
 */
function buildGenerateRequest(params: FlowGenerationParams, count = 1): Record<string, unknown> {
  const aspect = aspectFor(params.aspectRatio)
  const seed = params.seed ?? Math.floor(Math.random() * 2147483647)
  const modelKey = params.modelKey || DEFAULT_MODEL_KEY

  const requests = Array.from({ length: count }, (_v, i) => ({
    videoModelKey: modelKey,
    aspectRatio: aspect,
    seed: seed + i,
    textInput: { prompt: params.prompt },
    metadata: params.sceneId ? { sceneId: params.sceneId } : undefined
  }))

  const envelope: Record<string, unknown> = {
    clientContext: { sessionId: randomSessionId(), tool: 'PINHOLE' },
    requests
  }

  if (params.firstFrameMediaId) {
    envelope.firstFrame = { mediaId: params.firstFrameMediaId }
  }
  if (params.lastFrameMediaId) {
    envelope.lastFrame = { mediaId: params.lastFrameMediaId }
  }
  return envelope
}

/** Pick the REST route that matches the requested generation mode. */
function routeFor(params: FlowGenerationParams): string {
  if (params.firstFrameMediaId && params.lastFrameMediaId) {
    return '/video:batchAsyncGenerateVideoStartAndEndImage'
  }
  if (params.firstFrameMediaId) {
    return '/video:batchAsyncGenerateVideoStartAndEndImage'
  }
  return '/video:batchAsyncGenerateVideoText'
}

/** Extract operation names from a generation response, tolerating shape drift. */
function extractOperations(res: unknown): FlowOperation[] {
  const out: FlowOperation[] = []
  const walk = (node: unknown, depth = 0): void => {
    if (!node || depth > 6 || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1))
      return
    }
    const obj = node as Record<string, unknown>
    for (const key of ['name', 'operationName', 'id']) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 8 && !out.some((o) => o.name === v)) {
        out.push({ name: v })
      }
    }
    for (const v of Object.values(obj)) walk(v, depth + 1)
  }
  walk(res)
  return out
}

/** Best-effort media URL / inline payload extraction from a status response. */
function extractMedia(res: unknown): FlowStatusItem[] {
  const items: FlowStatusItem[] = []
  const seen = new Set<string>()

  const pushUrl = (url: string, name?: string): void => {
    if (!/^https?:\/\//.test(url) || seen.has(url)) return
    seen.add(url)
    items.push({ url, name })
  }
  const pushB64 = (b64: string, name?: string): void => {
    if (b64.length < 1000) return
    items.push({ base64: b64, name, done: true })
  }

  const walk = (node: unknown, depth = 0): void => {
    if (!node || depth > 8) return
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, depth + 1))
      return
    }
    if (typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : undefined
    const done = obj.done === true
    const status = typeof obj.status === 'string' ? obj.status : undefined

    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') continue
      if (/url|uri|Fife|fifeUrl|videoUri|mediaUrl/i.test(k)) pushUrl(v, name)
      if (/bytesBase64Encoded|base64/i.test(k)) pushB64(v, name)
      if (/^\s*\[?\{/.test(v) === false && v.startsWith('http')) pushUrl(v, name)
    }
    if (done || status === 'SUCCESSFUL' || status === 'SUCCEEDED') {
      items.push({ name, done: true, status })
    }
    for (const v of Object.values(obj)) walk(v, depth + 1)
  }
  walk(res)
  return items
}

export interface FlowSubmitResult {
  operations: FlowOperation[]
  raw: unknown
}

/** Submit a text-to-video (or image-to-video) job. */
export async function submitVideo(
  token: string,
  params: FlowGenerationParams,
  signal?: AbortSignal
): Promise<FlowSubmitResult> {
  const route = routeFor(params)
  const res = await call(token, route, buildGenerateRequest(params), signal)
  const operations = extractOperations(res)
  log('submit ->', route, 'operations:', operations)
  return { operations, raw: res }
}

/**
 * Poll `batchCheckAsyncVideoGenerationStatus`.
 * The API has historically accepted both `{operations:[{operation:{name}}]}` and the
 * flat `{operations:[{name}]}`; we send the nested form and fall back on an empty reply.
 */
export async function checkStatus(
  token: string,
  operations: FlowOperation[],
  signal?: AbortSignal
): Promise<unknown> {
  const nested = { operations: operations.map((o) => ({ operation: { name: o.name } })) }
  let res = await call(token, '/video:batchCheckAsyncVideoGenerationStatus', nested, signal)
  if (extractMedia(res).length === 0 && extractOperations(res).length === 0) {
    const flat = { operations: operations.map((o) => ({ name: o.name })) }
    log('checkStatus: nested form empty, retrying flat form')
    res = await call(token, '/video:batchCheckAsyncVideoGenerationStatus', flat, signal)
  }
  return res
}

/** Download the produced MP4 bytes from whatever media URL Flow returned. */
async function downloadMedia(token: string, url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal })
  if (!res.ok) throw new Error(`Gagal mengunduh hasil Flow (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * End-to-end: submit, poll until a finished media item appears, download it.
 * Returns `{ bytes, contentType }` matching the shape the existing video pipeline
 * expects from `antigravity.generateVideo()`.
 */
export async function generateVideo(
  token: string,
  params: FlowGenerationParams,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<{ bytes: Buffer; contentType: string }> {
  const { operations, raw: submitRaw } = await submitVideo(token, params, opts.signal)
  const names = operations.length ? operations : []
  if (!names.length) {
    // No operation handles: the submit response itself may already carry media.
    const immediate = extractMedia(submitRaw).filter((m) => m.url || m.base64)
    if (immediate.length) return await materialise(token, immediate[0], opts.signal)
    throw new Error(
      'Google Flow tidak mengembalikan operasi apa pun. Jalankan dengan FLOW_DEBUG=1 untuk melihat respons mentah.'
    )
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60 * 1000)
  const pollMs = opts.pollMs ?? 4000
  let last: unknown = null

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Dibatalkan')
    await sleep(pollMs, opts.signal)
    last = await checkStatus(token, names, opts.signal)
    const media = extractMedia(last).filter((m) => m.url || m.base64)
    if (media.length) return await materialise(token, media[0], opts.signal)
    if (extractError(last)) throw new Error(`Google Flow gagal: ${extractError(last)}`)
  }
  throw new Error(
    `Google Flow tidak selesai dalam ${Math.round((opts.timeoutMs ?? 300000) / 1000)}s. Respons terakhir: ${JSON.stringify(last).slice(0, 400)}`
  )
}

function extractError(res: unknown): string | null {
  const walk = (node: unknown, depth = 0): string | null => {
    if (!node || depth > 6 || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const n of node) {
        const e = walk(n, depth + 1)
        if (e) return e
      }
      return null
    }
    const obj = node as Record<string, unknown>
    if (obj.error) {
      const err = obj.error as Record<string, unknown>
      const msg = err.message || err.status || err.code
      if (typeof msg === 'string') return msg
      return JSON.stringify(err).slice(0, 300)
    }
    for (const v of Object.values(obj)) {
      const e = walk(v, depth + 1)
      if (e) return e
    }
    return null
  }
  return walk(res)
}

async function materialise(
  token: string,
  item: FlowStatusItem,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  if (item.base64) return { bytes: Buffer.from(item.base64, 'base64'), contentType: 'video/mp4' }
  if (item.url) return { bytes: await downloadMedia(token, item.url, signal), contentType: 'video/mp4' }
  throw new Error('Google Flow tidak mengembalikan media yang bisa diunduh.')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new Error('Dibatalkan'))
        },
        { once: true }
      )
    }
  })
}

/** Restrict CLI/probe helpers so they cannot be tree-shaken away by accident. */
export const FLOW_ENDPOINTS = {
  base: FLOW_API_BASE,
  textToVideo: '/video:batchAsyncGenerateVideoText',
  startAndEndImage: '/video:batchAsyncGenerateVideoStartAndEndImage',
  extendVideo: '/video:batchAsyncGenerateVideoExtendVideo',
  referenceImages: '/video:batchAsyncGenerateVideoReferenceImages',
  upsampleVideo: '/video:batchAsyncGenerateVideoUpsampleVideo',
  checkStatus: '/video:batchCheckAsyncVideoGenerationStatus',
  credits: '/credits'
} as const
