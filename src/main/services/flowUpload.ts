/**
 * Image upload for Flow, over the cookie bridge.
 *
 * Why this file exists: the REST surface at `aisandbox-pa.googleapis.com/v1` can *consume* a
 * Flow media id (`firstFrame.mediaId`) but cannot *mint* one — every REST upload path 404s
 * while the generation routes 401. The only way in is the web client's own RPC
 * `/FlowService.UploadImage` (short id `maseQ`), which requires the logged-in session. Hence
 * upload here (bridge), generate over REST (OAuth). See docs/flow-api-re.md §6.
 *
 * `maseQ` request field map, positional (index = field - 1), recovered from the bundle:
 *   1  context (project/collection)        6  -
 *   2  image bytes, base64                 7  crop coordinates
 *   3  mimeType                            8  isHidden
 *   4  crop flag (web client sends true)   9  fileName
 *   5  -                                  10  dimensions { width, height }
 * Response field 1 is the created `Media`; its id is what generation needs.
 */
import { callFlowRpc } from './flowSession'

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

  // Positional jspb array: index = field - 1.
  const args: unknown[] = []
  args[0] = input.context ?? null // 1 context
  args[1] = input.bytes.toString('base64') // 2 bytes
  args[2] = mimeType // 3 mimeType
  args[3] = input.crop ?? true // 4 crop flag
  args[6] = null // 7 crop coordinates
  args[7] = false // 8 isHidden
  args[8] = fileName // 9 fileName
  args[9] =
    input.width && input.height ? { width: input.width, height: input.height } : null // 10

  while (args.length && args[args.length - 1] === null) args.pop()

  const res = await callFlowRpc(FLOW_RPC.uploadImage, args)

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
