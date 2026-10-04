/**
 * Image upload for Flow, over the cookie bridge.
 *
 * Why this file exists: the REST surface at `aisandbox-pa.googleapis.com/v1` can *consume* a
 * Flow media id (`firstFrame.mediaId`) but cannot *mint* one — every REST upload path 404s
 * while the generation routes 401. The only way in is the web client's own RPC
 * `/FlowService.UploadImage` (short id `maseQ`), which requires the logged-in session. Hence
 * upload here (bridge), generate over REST (OAuth). See docs/flow-api-re.md §6.
 *
 * `maseQ` request field map, recovered from the bundle (`_.rp`/`_.Mv` calls in `mod_XRV0Af.js`):
 *   1  context (project id lives at field 6 of it)   8  isHidden
 *   2  image bytes, base64                          9  fileName
 *   3  mimeType                                    11  seed (int, optional)
 *   4  crop flag (web client sends true)           14  client config (optional)
 *   7  crop coordinates (optional)
 * An earlier draft of this file documented field 10 as `dimensions` — that was a guess and is
 * wrong; the bundle writes an optional context-ish message there. Nothing is sent at 10 now.
 * Response field 1 is the created `Media`; its id is what generation needs.
 */
import { callFlowRpc, callFlowRpcAuto } from './flowSession'
import { buildFlowContext } from './flowGenerate'

/** batchexecute short ids recovered from the bundle (docs/flow-api-re.md §6). */
export const FLOW_RPC = {
  uploadImage: 'maseQ',
  credits: 'nzlxg',
  generateFromText: 'YhhmEf',
  generateFromStartImage: 'eb1hJf',
  generateFromStartAndEndImage: 'nprQif',
  checkStatus: 'jwpduf',
  getMedia: 'as29s',
  projectContents: 'Zzl0ze'
} as const

export interface FlowUploadResult {
  mediaId: string
  /** Full parsed payload — keep it so a shape change is debuggable instead of mysterious. */
  payload: unknown
}

export interface FlowUploadInput {
  bytes: Buffer
  mimeType?: string
  fileName?: string
  width?: number
  height?: number
  crop?: boolean
  /** Project/collection context (field 1). Omitted when unknown — the error then says so. */
  context?: unknown
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPAQUE_RE = /^[A-Za-z0-9_-]{16,}$/

/**
 * Pull the media id out of an upload response. The web client reads it off response field 1
 * (`Media.id`), but the exact inner position is not documented anywhere, so this tries the
 * likely spots and then falls back to "the first id-looking string in the tree" — with the raw
 * payload kept by the caller, a miss is a one-line fix rather than a rewrite.
 */
function findMediaId(node: unknown, depth = 0): string | null {
  if (depth > 6 || node == null) return null
  if (typeof node === 'string') {
    if (UUID_RE.test(node)) return node
    return null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findMediaId(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const key of ['mediaId', 'media_id', 'id']) {
      const v = obj[key]
      if (typeof v === 'string' && (UUID_RE.test(v) || OPAQUE_RE.test(v))) return v
    }
    for (const v of Object.values(obj)) {
      const hit = findMediaId(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/** `true` when the payload reports a hard failure (per-RPC error envelope). */
function rpcError(payloads: unknown[]): string | null {
  for (const p of payloads) {
    if (p && typeof p === 'object' && 'error' in (p as object)) {
      const err = (p as Record<string, unknown>).error
      return typeof err === 'string' ? err : JSON.stringify(err)
    }
  }
  return null
}

/** Upload one image into the logged-in Flow session and return its media id. */
export async function uploadImageToFlow(input: FlowUploadInput): Promise<FlowUploadResult> {
  const mimeType = input.mimeType ?? 'image/png'
  const fileName = input.fileName ?? 'frame.png'

  // jspb `toObject` serialises a request as a plain object whose keys are *field numbers*,
  // so the wire shape is `{"1":…,"3":…}` — not a positional array. `callFlowRpcAuto` retries the
  // positional form anyway, because that older encoding was what the first draft used.
  const args: Record<string, unknown> = {
    1: input.context ?? (await buildFlowContext()), // context (project/collection)
    2: input.bytes.toString('base64'), // bytes
    3: mimeType, // mimeType
    4: input.crop ?? true, // crop flag
    8: false, // isHidden
    9: fileName // fileName
  }
  if (input.width && input.height) args[10] = { 1: input.width, 2: input.height }

  const res = await callFlowRpcAuto(FLOW_RPC.uploadImage, args)

  if (res.stage) {
    throw new Error(`Upload ke Google Flow gagal (${res.stage}): ${res.error ?? 'tidak diketahui'}`)
  }
  if (!res.ok) {
    throw new Error(`Upload ke Google Flow ditolak (HTTP ${res.status}): ${res.raw.slice(0, 400)}`)
  }
  const err = rpcError(res.payloads)
  if (err) throw new Error(`Upload ke Google Flow error: ${err}`)

  const mediaId = findMediaId(res.payloads)
  if (!mediaId) {
    throw new Error(
      `Upload jalan tapi media id tidak ketemu di respons. Kirim teks ini ke developer: ` +
        res.raw.slice(0, 600)
    )
  }
  return { mediaId, payload: res.payloads }
}

/** Credits left on the account — doubles as the cheapest "is the bridge alive?" probe. */
export async function getFlowCredits(): Promise<{ ok: boolean; status: number; raw: string; payloads: unknown[] }> {
  const res = await callFlowRpc(FLOW_RPC.credits, [])
  return { ok: res.ok, status: res.status, raw: res.raw, payloads: res.payloads }
}
