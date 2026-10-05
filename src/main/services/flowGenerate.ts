/**
 * Flow **generation** over the cookie bridge — the single-login path.
 *
 * Why this file exists
 * --------------------
 * `/v1/video:batchAsyncGenerateVideo*` on `aisandbox-pa.googleapis.com` speaks OAuth, and
 * `/FlowService.UploadImage` does not exist on that surface at all (every upload path 404s).
 * So the previous design needed *two* identities: an OAuth token for generation and a browser
 * session for upload. That is a bad user experience and a worse security story.
 *
 * The web client generates through the same batchexecute endpoint it uploads through, so this
 * module ports the generation RPCs across. Result: one Google login (the bridge window) drives
 * upload, generation, status polling and download.
 *
 * Field maps — recovered from the production bundle
 * -------------------------------------------------
 * `mod_XRV0Af.js` (`boq_labs-ai-sandbox-frontend_20261002.00_p0`). The app builds its request
 * with jspb builders and serialises it via `transport.Nb = request; XC(transport, 'f.req',
 * request.je())`, where `je()` is `JSON.stringify(toObject(request))` — i.e. the wire payload is
 * proto-JSON **keyed by field number as a string**. Every index below is a real proto field
 * number, quoted from the builder that sets it:
 *
 *   envelope (request, one per $4a/l5a/f5a/… class)
 *     1  repeated item        `X4a(a,b) -> _.Bv(a,1,array)`      (one item per generation)
 *     2  context              `Y4a(a,b) -> _.rp(a,2,obj)`
 *     3  trace                `Z4a(a,b) -> _.rp(a,3,obj)`
 *
 *   item, text-to-video (`YhhmEf`, class `h5a`)
 *     1  prompt               `G = _.rp(G,1,h)`
 *     2  videoModelKey        `G = _.Mv(G,2,c.Qg)`
 *     3  aspectRatio          `.setAspectRatio(c.aspectRatio)`   (enum name in JSON)
 *     5  metadata             `D = _.rp(G,5,D)`
 *     7  ml (unknown object)  `D = _.rp(D,7,c.ml)`
 *     8  resolution           `G = _.rp(G,8,J)`
 *
 *   item, image-to-video (`eb1hJf`, class `b5a`) /
 *   item, first+last frame (`nprQif`, class `W4a`)
 *     1  prompt, 2 videoModelKey, 3 aspectRatio                       (identical to above)
 *     5  firstFrame           `D = _.rp(D,5,G)`   G = `bQ(cQ(new dQ, c.lN), NN(c.kN))`
 *     6  lastFrame / metadata `nprQif` puts lastFrame here, `eb1hJf` puts metadata here
 *     7  metadata (`nprQif` only), 9 ml, 10 resolution (`eb1hJf` only)
 *
 *   context `_.dK`
 *     2  constant 22          `_.cK(new _.dK) -> _.up(a,2,22)`
 *     6  project id           `hR(a,b) -> _.io(a,6,b)`   (b = the project id)
 *     8  collection id        `Z1a(a,b) -> _.io(a,8,b)`
 *     9  workflow id          `Y1a(a,b) -> _.io(a,9,b)`
 *    11  reCAPTCHA            `iR(a,b) -> _.rp(a,11,b)`, b = `_.ZQ(_.YQ(token))` = `{ "1": "<token>", "2": 1 }`
 *
 *   trace `qR`
 *     1  trace id             `H2a(a,b) -> _.io(a,1,b)`
 *     2  audio preference     `I2a(a,b) -> _.up(a,2,b)`
 *     4  destination          `J2a(a,b) -> _.Av(a,4,G2a,b)`
 *
 *   frames
 *     `cQ(a,mediaId) -> _.Nv(a,2,B4a,mediaId)`  -> `{ "2": { "1": "<mediaId>" } }`
 *     `bQ(a,crop)    -> _.rp(a,6,crop)`         -> `{ "6": { "1": top, "2": left, "3": bottom, "4": right } }`
 *     `NN(crop)` sets those four ints (`_.Ic(b,1,_.tb(a.top),0)` …)
 *
 *   metadata `_.fy` (`l(seed)` in the bundle)
 *     1  destination scene    `_.Mv(V,1,destination?.yka?.ve)`
 *     2  workflow id          `_.Mv(V,2,destination?.workflowId)`
 *     3  collection id        `_.Mv(V,3,destination.wb)`
 *     5  **seed**             `_.io(V,5,d[i])`
 *     6  per-item extra       `_.io(V,6,e?.[i])`
 *
 *   status (`jwpduf`, class `u5a`)
 *    3  repeated ids          `t5a(a,b) -> _.Bv(a,3,array)`, each `_.Lx{ 1: id }`
 *       … and the *response* reuses field 3: `_.Lx{ 1: id, 3: status string }`
 *
 *   project
 *    `jHPbke` CreateProject  request `{ 2: { 2: { 1: name } }, 3: context }`; response `_.hK`,
 *                            whose `mc()` is `_.Z(this,1)` — the project id lives at field 1.
 *    `UpteDb` GetProjects    used first so we reuse an existing project instead of littering.
 *
 * Not reconstructed (deliberately omitted, never guessed): the `ml` payload object (item field
 * 9 / 7). The reCAPTCHA *wrapper* is no longer a guess — `_.ZQ(_.YQ(token))` is
 * `{ "1": "<token>", "2": 1 }` appended to the repeated context field 11, and the token comes from
 * `grecaptcha.enterprise.execute(WIZ_global_data.xZbWve, { action: 'VIDEO_GENERATION' })`, run in
 * the live page by `flowSession.getFlowRecaptchaToken`.
 *
 * Generation is reCAPTCHA-gated: the web client submits `enable_prompt_submit_is_trusted_check`
 * via that action, and a request without the token is answered with a `wrb.fr` entry whose payload
 * is *null* — `["wrb.fr","<rpc>",null,null,null,[3],"generic"]`, i.e. no id to poll. That is the
 * exact reply a live run reported before field 11 was filled in.
 */
import {
  callFlowRpc,
  callFlowRpcAuto,
  downloadFlowMedia,
  getFlowRecaptchaToken,
  FLOW_ROUTE,
  type FlowRpcResult
} from './flowSession'

/** batchexecute short ids, all confirmed against the bundle's `new _.Gx(...)` table. */
export const FLOW_BOQ_RPC = {
  generateFromText: 'YhhmEf',
  generateFromStartImage: 'eb1hJf',
  generateFromStartAndEndImage: 'nprQif',
  checkStatus: 'jwpduf',
  getProjects: 'UpteDb',
  createProject: 'jHPbke',
  getProject: 'ngNC2',
  uploadImage: 'maseQ',
  credits: 'nzlxg'
} as const

/** Flow's own enum names (`_.rJ`) — these are what land in the JSON for a proto enum field. */
const ASPECT_TO_BOQ: Record<string, string> = {
  VIDEO_ASPECT_RATIO_LANDSCAPE: 'LANDSCAPE',
  VIDEO_ASPECT_RATIO_PORTRAIT: 'PORTRAIT',
  VIDEO_ASPECT_RATIO_SQUARE: 'SQUARE',
  VIDEO_ASPECT_RATIO_LANDSCAPE_4_3: 'LANDSCAPE_4_3',
  VIDEO_ASPECT_RATIO_PORTRAIT_3_4: 'PORTRAIT_3_4',
  LANDSCAPE: 'LANDSCAPE',
  PORTRAIT: 'PORTRAIT',
  SQUARE: 'SQUARE',
  LANDSCAPE_4_3: 'LANDSCAPE_4_3',
  PORTRAIT_3_4: 'PORTRAIT_3_4'
}

export type FlowGenMode = 'TEXT' | 'START_FRAME' | 'START_END_FRAMES'

/** Flow wire model key used when the caller does not pin one (same default as the REST route). */
export const DEFAULT_FLOW_MODEL_KEY = 'veo_3_1_t2v_fast'

export interface FlowBridgeFrameCrop {
  top: number
  left: number
  bottom: number
  right: number
}

export interface FlowBridgeGenParams {
  prompt: string
  /** Flow wire model key (`c.Qg`). Defaults to `DEFAULT_FLOW_MODEL_KEY`. */
  modelKey?: string
  /** Force a specific RPC instead of inferring it from the frames. */
  mode?: FlowGenMode
  aspectRatio?: string
  /** Seeds the per-item metadata (field 5). Random when absent. */
  seed?: number
  /** Flow project id (`c.ya`). Resolved automatically when absent. */
  projectId?: string
  firstFrameMediaId?: string
  lastFrameMediaId?: string
  crop?: FlowBridgeFrameCrop
  /** `c.td` — a per-request trace id. Random UUID when absent. */
  traceId?: string
  /** 1 = fail the job when the source has audio the model cannot carry. */
  audioFailurePreference?: number
}

export interface FlowBridgeStatusItem {
  id?: string
  status?: string
  url?: string
  base64?: string
  done: boolean
  failed: boolean
}

export interface FlowBridgeStatus {
  items: FlowBridgeStatusItem[]
  raw: unknown
  error?: string
}

let cachedProjectId: string | null = null

function debug(...args: unknown[]): void {
  if (process.env.FLOW_DEBUG) console.log('[flow-bridge]', ...args)
}

// ---------------------------------------------------------------------------------------------
// payload builders
// ---------------------------------------------------------------------------------------------

function randomSeed(): number {
  return Math.floor(Math.random() * 2147483647)
}

/** `_.cu(C4a(new D4a, zj))` — the prompt message: field 3 holds the structured prompt, whose
 *  field 1 is the repeated parts, each part's field 1 being the literal text. */
function promptField(prompt: string): Record<string, unknown> {
  return { 3: { 1: [{ 1: prompt }] } }
}

/** `_.cu(bQ(cQ(new dQ, mediaId), crop))` — frame reference at item field 5 / 6. */
function frameField(mediaId: string, crop?: FlowBridgeFrameCrop): Record<string, unknown> {
  // The bundle writes both fields unconditionally — `bQ(cQ(new dQ, mediaId), NN(crop))` — and
  // `NN(undefined)` yields an empty message, so a frame with only field 2 is a shape the web client
  // never produces.
  const frame: Record<string, unknown> = { 2: { 1: mediaId } }
  frame[6] = crop ? { 1: crop.top, 2: crop.left, 3: crop.bottom, 4: crop.right } : {}
  return frame
}

/** `l(i)` — per-item metadata. Only the seed is known to matter; the rest mirror `destination`. */
function metadataField(seed: number): Record<string, unknown> {
  return { 5: seed }
}

/** `_.cu(iR(hR(_.cK(new _.dK), projectId), recaptcha))` — the shared context message. */
function contextField(projectId: string | null, recaptchaToken?: string): Record<string, unknown> {
  const context: Record<string, unknown> = { 2: 22 }
  if (projectId) context[6] = projectId
  // `iR(context, _.ZQ(_.YQ(token)))`. The nesting is load-bearing: `_.YQ(t)` is `M1a{1: t}` and
  // `_.ZQ(m)` sets `m{2: 1}`, so field 11 is a *repeated message*, not a string. Sending the bare
  // token string is rejected exactly like sending nothing.
  if (recaptchaToken) context[11] = [{ 1: recaptchaToken, 2: 1 }]
  return context
}

/** `_.cu(J2a(I2a(H2a(new qR, traceId), audioPreference), destination))`. */
function traceField(traceId: string, audioFailurePreference?: number): Record<string, unknown> {
  const trace: Record<string, unknown> = { 1: traceId }
  if (audioFailurePreference != null) trace[2] = audioFailurePreference
  return trace
}

/**
 * `MXa(aspectRatio)` — item field 3 carries an **integer**, not the enum name. The bundle maps the
 * enum to 0 (square) / 1 (landscape) / 2 (portrait) before writing it, and `tN()` picks the model by
 * matching those integers against the model's supported list. Sending the name — what this did —
 * is a type error at a known field number, which is exactly the INVALID_ARGUMENT the server has
 * been answering with `["wrb.fr","<rpc>",null,…,null,[3],"generic"]`.
 */
const ASPECT_INT: Record<string, number> = {
  SQUARE: 0,
  LANDSCAPE: 1,
  LANDSCAPE_4_3: 1,
  PORTRAIT: 2,
  PORTRAIT_3_4: 2
}

function aspectFor(aspectRatio?: string): number {
  const name = aspectRatio ? (ASPECT_TO_BOQ[aspectRatio] ?? aspectRatio) : 'LANDSCAPE'
  return ASPECT_INT[name] ?? 1
}

/** One item of the request, using the field numbers quoted in this file's header. */
export function buildGenerateItem(
  mode: FlowGenMode,
  params: FlowBridgeGenParams,
  seed: number
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    1: promptField(params.prompt),
    2: params.modelKey ?? DEFAULT_FLOW_MODEL_KEY,
    3: aspectFor(params.aspectRatio)
  }

  if (mode === 'TEXT') {
    item[5] = metadataField(seed)
    return item
  }

  if (params.firstFrameMediaId) item[5] = frameField(params.firstFrameMediaId, params.crop)

  if (mode === 'START_END_FRAMES') {
    if (params.lastFrameMediaId) item[6] = frameField(params.lastFrameMediaId)
    item[7] = metadataField(seed)
    return item
  }

  // START_FRAME — metadata sits at field 6 here, not 5.
  item[6] = metadataField(seed)
  return item
}

/** The whole `$4a`/`l5a`/`f5a` request: items + context + trace. */
export function buildGenerateRequest(
  mode: FlowGenMode,
  params: FlowBridgeGenParams,
  projectId: string | null,
  count = 1,
  recaptchaToken?: string
): Record<string, unknown> {
  const baseSeed = params.seed ?? randomSeed()
  const items = Array.from({ length: Math.max(1, count) }, (_v, i) =>
    buildGenerateItem(mode, params, baseSeed + i)
  )
  return {
    1: items,
    2: contextField(projectId, recaptchaToken),
    3: traceField(params.traceId ?? randomUUID(), params.audioFailurePreference)
  }
}

/** The envelope as sent, with base64 bodies collapsed — for the error text the user pastes back. */
function describeRequest(request: unknown): string {
  try {
    return JSON.stringify(request, (_k, v) =>
      typeof v === 'string' && v.length > 200 ? `<${v.length} chars>` : v
    ).slice(0, 1200)
  } catch {
    return '<tidak bisa diserialisasi>'
  }
}

function randomUUID(): string {
  // crypto.randomUUID is available in the Electron main process (Node 18+).
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  }
}

export function rpcForMode(mode: FlowGenMode): string {
  if (mode === 'TEXT') return FLOW_BOQ_RPC.generateFromText
  if (mode === 'START_FRAME') return FLOW_BOQ_RPC.generateFromStartImage
  return FLOW_BOQ_RPC.generateFromStartAndEndImage
}

export function modeForParams(params: FlowBridgeGenParams): FlowGenMode {
  if (params.mode) return params.mode
  // This is the bundle's own branch: both frames -> `nprQif` (StartAndEndImage), a lone first
  // frame -> `eb1hJf` (StartImage), nothing -> `YhhmEf` (text). The old default sent `nprQif` with
  // a *null* last frame, which is a route the web client never produces — and asking
  // StartAndEndImage for a video with no end frame is the kind of request the server answers with
  // an empty payload.
  if (params.firstFrameMediaId && params.lastFrameMediaId) return 'START_END_FRAMES'
  if (params.firstFrameMediaId) return 'START_FRAME'
  return 'TEXT'
}

// ---------------------------------------------------------------------------------------------
// response walking
// ---------------------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** First UUID anywhere in the payload — Flow media and operation ids are UUIDs. */
function firstUuid(node: unknown, depth = 0): string | null {
  if (depth > 8 || node == null) return null
  if (typeof node === 'string') return UUID_RE.test(node) ? node : null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = firstUuid(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = firstUuid(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/** Every id-looking string, deepest-first order preserved, de-duplicated. */
function allUuids(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || node == null) return out
  if (typeof node === 'string') {
    if (UUID_RE.test(node) && !out.includes(node)) out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) allUuids(item, out, depth + 1)
    return out
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      allUuids(value, out, depth + 1)
    }
  }
  return out
}

/** Any http(s) URL in the payload — that is where Flow puts the produced MP4 (Fife). */
function firstUrl(node: unknown, depth = 0): string | null {
  if (depth > 10 || node == null) return null
  if (typeof node === 'string') return /^https?:\/\//.test(node) ? node : null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = firstUrl(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && /url|uri|fife|media/i.test(key) && /^https?:\/\//.test(value)) {
        return value
      }
    }
    for (const value of Object.values(obj)) {
      const hit = firstUrl(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/** First long base64 blob in the payload (some responses inline the video). */
function firstBase64(node: unknown, depth = 0): string | null {
  if (depth > 10 || node == null) return null
  if (typeof node === 'string') return node.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(node) ? node : null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = firstBase64(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = firstBase64(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

const FAILED_STATUS = /fail|cancel|error|blocked|reject|unsafe/i
const DONE_STATUS = /success|succeed|complete|done|ready/i

/** Collect `{1: id, 3: status}` pairs out of the status RPC's field 3 list. */
function walkStatusList(node: unknown, out: FlowBridgeStatusItem[], depth = 0): void {
  if (depth > 8 || node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walkStatusList(item, out, depth + 1)
    return
  }
  const obj = node as Record<string, unknown>
  const id = typeof obj['1'] === 'string' ? (obj['1'] as string) : undefined
  const status = typeof obj['3'] === 'string' ? (obj['3'] as string) : undefined
  if (id && status) {
    out.push({
      id,
      status,
      url: firstUrl(obj) ?? undefined,
      base64: firstBase64(obj) ?? undefined,
      done: DONE_STATUS.test(status),
      failed: FAILED_STATUS.test(status)
    })
  }
  for (const value of Object.values(obj)) walkStatusList(value, out, depth + 1)
}

function rpcErrorOf(res: FlowRpcResult): string | null {
  for (const payload of res.payloads) {
    if (payload && typeof payload === 'object' && 'error' in (payload as object)) {
      const err = (payload as Record<string, unknown>).error
      return typeof err === 'string' ? err : JSON.stringify(err)
    }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// project resolution
// ---------------------------------------------------------------------------------------------

/** Field 1 of a `_.hK` is the project id (`_.hK.mc()`), so prefer it, then any UUID. */
function pickProjectId(payloads: unknown[]): string | null {
  for (const payload of payloads) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const first = (payload as Record<string, unknown>)['1']
      if (typeof first === 'string' && first.length > 3) return first
    }
  }
  return firstUuid(payloads)
}

/**
 * The context message that both upload (`maseQ` field 1) and generation (request field 2) carry:
 * field 2 is the enum flag the web client always sends (22), field 6 is the project id.
 */
export async function buildFlowContext(): Promise<Record<string, unknown>> {
  return contextField(await ensureFlowProject())
}

export function getCachedFlowProjectId(): string | null {
  return cachedProjectId
}

/**
 * Reuse the account's first Flow project; create one only when the account has none. Result is
 * cached for the process lifetime because the id is stable and unrelated to the job.
 */
export async function ensureFlowProject(force = false): Promise<string | null> {
  if (cachedProjectId && !force) return cachedProjectId

  const listed = await callFlowRpcAuto(FLOW_BOQ_RPC.getProjects, { 3: contextField(null) }, FLOW_ROUTE)
  if (listed.stage === 'login' || listed.stage === 'wiz') return null
  const existing = pickProjectId(listed.payloads)
  if (existing) {
    cachedProjectId = existing
    debug('reusing Flow project', existing)
    return existing
  }

  const created = await callFlowRpcAuto(
    FLOW_BOQ_RPC.createProject,
    { 2: { 2: { 1: 'ytlogidex' } }, 3: contextField(null) },
    FLOW_ROUTE
  )
  const made = pickProjectId(created.payloads)
  if (made) {
    cachedProjectId = made
    debug('created Flow project', made)
    return made
  }
  debug('project resolution failed; sending context without a project id')
  return null
}

// ---------------------------------------------------------------------------------------------
// submit / poll / download
// ---------------------------------------------------------------------------------------------

export interface FlowBridgeSubmitResult {
  mode: FlowGenMode
  rpcId: string
  /** Candidate ids for status polling. */
  ids: string[]
  raw: unknown
  /** The exact envelope that was sent (for FLOW_DEBUG and for pinning the schema). */
  request: unknown
}

/** Whether an RPC result proves the request reached Flow's backend. */
function transportFailure(res: FlowRpcResult): string | null {
  if (res.stage) return `sesi Flow belum siap (${res.stage}): ${res.error ?? 'tidak diketahui'}`
  if (!res.ok) return `RPC ditolak (HTTP ${res.status}): ${res.raw.slice(0, 300)}`
  return rpcErrorOf(res)
}

/**
 * Flow decides which video models an account may use and hands the list to the web client through
 * `cPZSdc` (`/VideoFxService.GetFlowAppConfig`). The repo's `veo_3_1_t2v_fast` default is therefore
 * a *guess*, and a wrong key is answered exactly like a missing one (INVALID_ARGUMENT, null payload)
 * — the failure mode this whole file keeps tripping over. Ask Flow instead of guessing.
 *
 * The response is a nested message tree that changes between builds, so walk it for strings shaped
 * like a model key rather than hardcoding a field path.
 */
// `HTrJv` is the one that matters: `/FlowService.GetModels`, found next to `Zzl0ze` in the same
// chunk. It takes an empty request (the SPA calls it as `fetch(M3a.nb(_.cu(new q3a)))`), so the
// same empty-args call should answer with the account's model list. `yBhWQ`
// (`/FlowService.ListModelStatuses`) is the per-account availability twin.
const MODEL_KEY_RPCS = ['HTrJv', 'yBhWQ', 'cPZSdc', 'gS5h8c', 'Yizz8d'] as const

let modelKeyCache: { at: number; keys: string[] } | null = null

function collectModelKeys(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    // Accept anything short and key-like that mentions "veo", not just the documented `veo_*` shape:
    // the naming has changed between builds, and a silent miss here falls back to a default that may
    // be the wrong modality entirely.
    // Not just `veo_*`: this build also ships Omni / Nano Banana models and a frames-to-video mode,
    // so a filter that only knows the old prefix silently misses the key that would have worked.
    if (value.length <= 60 && /^[A-Za-z0-9_]+$/.test(value) &&
      /veo|omni|nano|banana|_fast|_lite|_pro|_2v/i.test(value)) {
      out.add(value)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelKeys(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectModelKeys(item, out)
  }
}

/** Video model keys advertised for this account, cached for half an hour. Empty array = unknown. */
export async function fetchFlowModelKeys(force = false): Promise<string[]> {
  if (!force && modelKeyCache && Date.now() - modelKeyCache.at < 30 * 60_000) return modelKeyCache.keys
  const keys = new Set<string>()
  for (const rpcId of MODEL_KEY_RPCS) {
    try {
      const res = await callFlowRpcAuto(rpcId, {}, FLOW_ROUTE)
      let found = 0
      for (const payload of res.payloads) {
        const before = keys.size
        collectModelKeys(payload, keys)
        found += keys.size - before
      }
      debug(
        'model keys',
        rpcId,
        found ? `${found} baru` : 'KOSONG',
        `status=${res.status}`,
        found ? '' : res.raw.slice(0, 1200)
      )
      if (keys.size) break
    } catch (e) {
      debug('model keys', rpcId, 'gagal:', e instanceof Error ? e.message : String(e))
    }
  }
  const list = [...keys].sort()
  modelKeyCache = { at: Date.now(), keys: list }
  return list
}

/**
 * The key that matches the request. A first frame means the video is generated *from an image*, and
 * Flow serves that with an `i2v` model; text has to stay `t2v`. Sending a text-to-video key together
 * with a frame is an argument error, not a fallback.
 */
export function pickFlowModelKey(keys: string[], params: FlowBridgeGenParams): string {
  if (!keys.length) return ''
  const wantsImage = !!params.firstFrameMediaId
  const rank = (key: string): [number, number] => {
    // A first frame means the model has to accept frames: `f2v` (frames-to-video) or `i2v`
    // (image-to-video). A `t2v` key on that request is the argument error this file keeps hitting.
    const acceptsFrames = /f2v|i2v/i.test(key)
    const t2v = /t2v/i.test(key)
    const fit = wantsImage ? (acceptsFrames ? 0 : t2v ? 2 : 1) : t2v ? 0 : 1
    return [fit, key.includes('fast') ? 0 : 1]
  }
  return [...keys].sort((a, b) => {
    const [fa, sa] = rank(a)
    const [fb, sb] = rank(b)
    return fa - fb || sa - sb || a.localeCompare(b)
  })[0]
}

export async function submitBridgeGeneration(
  params: FlowBridgeGenParams,
  opts: { projectId?: string | null; count?: number } = {}
): Promise<FlowBridgeSubmitResult> {
  const mode = modeForParams(params)
  const rpcId = rpcForMode(mode)
  const projectId =
    opts.projectId !== undefined ? opts.projectId : (params.projectId ?? (await ensureFlowProject()))

  // Generation is reCAPTCHA-gated. The token carries the action, so it has to be minted per RPC.
  // Keep the note too: the reason a token is missing has to travel with the error, because the log
  // file is what never makes it back from the machine that failed.
  const recaptcha = await getFlowRecaptchaToken('VIDEO_GENERATION')
  const recaptchaToken = recaptcha.token

  // An explicit key still wins; otherwise ask Flow which models this account has and match the
  // key to the mode. A t2v key on an image-to-video request is an argument error, not a fallback.
  const resolvedKey = params.modelKey || pickFlowModelKey(await fetchFlowModelKeys(), params)
  const effectiveParams = resolvedKey && resolvedKey !== params.modelKey ? { ...params, modelKey: resolvedKey } : params
  debug('generate', mode, rpcId, 'modelKey=', resolvedKey || DEFAULT_FLOW_MODEL_KEY)

  const request = buildGenerateRequest(mode, effectiveParams, projectId ?? null, opts.count ?? 1, recaptchaToken)
  debug('submit', rpcId, mode, 'reCAPTCHA: ' + recaptcha.note, JSON.stringify(request))

  const res = await callFlowRpcAuto(rpcId, request, FLOW_ROUTE)
  debug('submit reply', rpcId, res.status, res.stage ?? '', res.raw.slice(0, 800))

  const failure = transportFailure(res)
  if (failure) throw new Error(`Google Flow menolak permintaan generate: ${failure}`)

  const ids = allUuids(res.payloads)
  if (!ids.length) {
    throw new Error(
      'Flow membalas tanpa id media/operasi, jadi status tidak bisa dilacak. ' +
        `reCAPTCHA: ${recaptcha.note}. ` +
        `Payload mentah: ${res.raw.slice(0, 600)}. ` +
        `Envelope terkirim: ${describeRequest(request)}`
    )
  }
  return { mode, rpcId, ids, raw: res.payloads, request }
}

/** `jwpduf`: request `{ 3: [ { 1: id }, … ] }`. */
export async function pollBridgeStatus(ids: string[]): Promise<FlowBridgeStatus> {
  if (!ids.length) return { items: [], raw: null }
  const request = { 3: ids.map((id) => ({ 1: id })) }
  const res = await callFlowRpcAuto(FLOW_BOQ_RPC.checkStatus, request, FLOW_ROUTE)

  const failure = transportFailure(res)
  if (failure) return { items: [], raw: res.payloads, error: failure }

  const items: FlowBridgeStatusItem[] = []
  walkStatusList(res.payloads, items)
  if (!items.length) {
    // Shape drift: fall back to a generic scan so a finished video is never missed.
    for (const id of ids) {
      items.push({
        id,
        url: firstUrl(res.payloads) ?? undefined,
        base64: firstBase64(res.payloads) ?? undefined,
        done: false,
        failed: false
      })
    }
  }
  debug('status', JSON.stringify(items))
  return { items, raw: res.payloads }
}

/** Download whatever the status reply points at, through the page session. */
async function materialiseStatusItem(
  item: FlowBridgeStatusItem
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (item.base64) {
    return { bytes: Buffer.from(item.base64, 'base64'), contentType: 'video/mp4' }
  }
  if (!item.url) return null
  const download = await downloadFlowMedia(item.url)
  if (!download.ok || !download.bytes) {
    throw new Error(`Gagal mengunduh hasil Flow: ${download.error ?? `HTTP ${download.status}`}`)
  }
  return { bytes: download.bytes, contentType: download.contentType || 'video/mp4' }
}

export interface FlowBridgeGenOptions {
  timeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
  projectId?: string | null
  authToken?: string
}

/**
 * End-to-end generation through the bridge: submit, poll `jwpduf` until a media URL shows up,
 * then download it inside the page. Returns the same shape as `flow.generateVideo()` so callers
 * do not care which transport ran.
 */
export async function generateVideoViaBridge(
  params: FlowBridgeGenParams,
  opts: FlowBridgeGenOptions = {}
): Promise<{ bytes: Buffer; contentType: string }> {
  const submitted = await submitBridgeGeneration(params, { projectId: opts.projectId })
  debug('submitted', submitted.mode, submitted.rpcId, 'ids:', submitted.ids)

  // Some replies already carry the finished media.
  const immediateUrl = firstUrl(submitted.raw)
  if (immediateUrl) {
    const ready = await materialiseStatusItem({ url: immediateUrl, done: true, failed: false })
    if (ready) return ready
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60 * 1000)
  const pollMs = opts.pollMs ?? 4000
  let last: FlowBridgeStatus | null = null

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('Dibatalkan')
    await sleep(pollMs, opts.signal)
    last = await pollBridgeStatus(submitted.ids)

    const finished = last.items.find((item) => (item.done || item.url || item.base64) && !item.failed)
    if (finished) {
      const media = await materialiseStatusItem(finished)
      if (media) return media
    }
    const failed = last.items.find((item) => item.failed)
    if (failed) {
      throw new Error(`Google Flow gagal membuat video (status: ${failed.status ?? 'tidak diketahui'})`)
    }
  }

  throw new Error(
    `Google Flow tidak selesai dalam ${Math.round((opts.timeoutMs ?? 300000) / 1000)}s. ` +
      `Respons terakhir: ${JSON.stringify(last?.raw ?? null).slice(0, 400)}`
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('Dibatalkan'))
        },
        { once: true }
      )
    }
  })
}

/** Cheap liveness probe that also proves the generation surface is reachable. */
export async function probeBridge(): Promise<FlowRpcResult> {
  return await callFlowRpc(FLOW_BOQ_RPC.credits, {}, FLOW_ROUTE)
}

// keep `callFlowRpc`/`callFlowRpcAuto` referenced for tooling that greps the bundle markers
export const FLOW_BOQ_ENDPOINT = 'https://labs.google/_/AiSandboxAngularFrontend/data/batchexecute'
export { callFlowRpc, callFlowRpcAuto }
