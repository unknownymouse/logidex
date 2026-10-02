import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { AspectRatio, KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
import { GEMINI_VOICES, geminiVoiceName, geminiVoiceTone } from '@shared/models'
import {
  ANTIGRAVITY_IMAGE_MODELS,
  ANTIGRAVITY_VIDEO_MODELS,
  ANTIGRAVITY_TTS_MODELS,
  ANTIGRAVITY_LLM_MODELS
} from '@shared/antigravity'
import { binPath } from '../paths'
import { getSecret } from '../secrets'
import { getSettings } from '../settings'
import { isWav, pcmToWav } from './audio'
import { downloadTo } from './http'
import { extractJson } from './json'
import { getOAuthStatus, getValidAccessToken } from './googleOAuth'

export {
  ANTIGRAVITY_IMAGE_MODELS,
  ANTIGRAVITY_VIDEO_MODELS,
  ANTIGRAVITY_TTS_MODELS,
  ANTIGRAVITY_LLM_MODELS,
  getAntigravityImageModel,
  getAntigravityVideoModel,
  getAntigravityLlmModel
} from '@shared/antigravity'

const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
]
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc'
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com'

const WIRE_MODEL_MAP: Record<string, string> = {
  'gemini-3.8-flash': 'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-tiered': 'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-tts': 'gemini-2.5-flash',
  'gemini-3.8-pro': 'gemini-3.1-pro-high',
  'gemini-3.5-flash': 'gemini-3.5-flash-low',
  'gemini-3.5-flash-tts': 'gemini-2.5-flash',
  'gemini-3.5-pro': 'gemini-3.1-pro-high',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.0-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash-lite': 'gemini-3.5-flash-extra-low',
  'gemini-1.5-flash': 'gemini-2.5-flash',
  'gemini-1.5-pro': 'gemini-2.5-pro',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium': 'gpt-oss-120b-medium',
  'imagen-3.0-generate-002': 'gemini-3.1-flash-image',
  'imagen-3.0-fast-generate-001': 'gemini-3.1-flash-image',
  'gemini-3.1-flash-image': 'gemini-3.1-flash-image'
}

const WIRE_MODEL_ENUMS: Record<string, string> = {
  'gemini-3.5-flash-extra-low': 'MODEL_PLACEHOLDER_M187',
  'gemini-3.5-flash-low': 'MODEL_PLACEHOLDER_M20',
  'gemini-3-flash-agent': 'MODEL_PLACEHOLDER_M84',
  'gemini-3.6-flash-low': 'MODEL_PLACEHOLDER_M73',
  'gemini-3.6-flash-medium': 'MODEL_PLACEHOLDER_M72',
  'gemini-3.6-flash-high': 'MODEL_PLACEHOLDER_M71',
  'gemini-3.7-flash-low': 'MODEL_PLACEHOLDER_M300',
  'gemini-3.7-flash-medium': 'MODEL_PLACEHOLDER_M299',
  'gemini-3.7-flash-high': 'MODEL_PLACEHOLDER_M298',
  'gemini-3.8-flash-low': 'MODEL_PLACEHOLDER_M320',
  'gemini-3.8-flash-medium': 'MODEL_PLACEHOLDER_M319',
  'gemini-3.8-flash-high': 'MODEL_PLACEHOLDER_M318',
  'gemini-3.8-flash-tiered': 'MODEL_PLACEHOLDER_M322',
  'gemini-3.1-pro-low': 'MODEL_PLACEHOLDER_M36',
  'gemini-3.1-pro-high': 'MODEL_PLACEHOLDER_M37',
  'gemini-pro-agent': 'MODEL_PLACEHOLDER_M16',
  'claude-sonnet-4-6': 'MODEL_PLACEHOLDER_M35',
  'claude-opus-4-6-thinking': 'MODEL_PLACEHOLDER_M26',
  'gemini-3.1-flash-image': 'MODEL_PLACEHOLDER_M21',
  'gpt-oss-120b-medium': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM'
}

let cachedProjectId: string | null = null

async function getAntigravityProjectId(token: string): Promise<string> {
  if (cachedProjectId) return cachedProjectId
  for (const ep of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await fetch(`${ep}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.107.0',
          'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
          'Client-Metadata': '{"ideType":"ANTIGRAVITY"}'
        },
        body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
      })
      if (res.ok) {
        const data = (await res.json()) as any
        const pId = data?.cloudaicompanionProject?.id || data?.cloudaicompanionProject
        if (typeof pId === 'string' && pId) {
          cachedProjectId = pId
          return pId
        }
      }
    } catch {
      // try next
    }
  }
  return DEFAULT_PROJECT_ID
}

function friendly(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e)
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return new Error('Gagal terhubung ke Google Antigravity. Periksa koneksi internet kamu.')
  }
  if (/401|unauthorized/i.test(msg)) {
    return new Error('Sesi Google OAuth kedaluwarsa. Silakan masuk ulang dengan Google di Pengaturan.')
  }
  return new Error(`Antigravity gagal: ${msg}`)
}

async function callAntigravityApi(
  action: string,
  modelName: string,
  requestPayload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<any> {
  const token = await getValidAccessToken()
  const rawKey = token || (getSecret('antigravity') ?? '')
  if (!rawKey.trim()) {
    throw new Error('Antigravity belum terhubung ke Google OAuth. Silakan masuk dengan Google di Pengaturan.')
  }

  const wireModel = WIRE_MODEL_MAP[modelName] || modelName
  const modelEnum = WIRE_MODEL_ENUMS[wireModel]
  const isClaude = wireModel.toLowerCase().startsWith('claude-')
  const isNonGemini = isClaude || wireModel.toLowerCase().startsWith('gpt-')
  const convId = crypto.randomUUID()
  const trajId = crypto.randomUUID()
  const ts = Date.now()

  const projectId = await getAntigravityProjectId(rawKey.trim())

  const wrappedBody = {
    project: projectId,
    requestId: `agent/${convId}/${ts}/${trajId}/1`,
    request: {
      ...requestPayload,
      labels: {
        last_step_index: '1',
        ...(modelEnum ? { model_enum: modelEnum } : {}),
        trajectory_id: trajId,
        used_claude: isClaude ? 'true' : 'false',
        used_claude_conservative: isClaude ? 'true' : 'false',
        used_non_gemini_model: isNonGemini ? 'true' : 'false',
        ...((requestPayload.labels as Record<string, string>) || {})
      },
      sessionId: '-4582910481920381048'
    },
    model: wireModel,
    userAgent: 'antigravity',
    requestType: 'agent'
  }

  let lastError: Error | null = null

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}/v1internal:${action}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawKey.trim()}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.107.0',
          'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
          'Client-Metadata': '{"ideType":"ANTIGRAVITY"}'
        },
        body: JSON.stringify(wrappedBody),
        signal
      })

      if (res.ok) {
        return await res.json()
      }

      const errJson = (await res.json().catch(() => null)) as any
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`

      if (res.status === 429 || /quota|exhausted/i.test(errMsg)) {
        const details = errJson?.error?.details || []
        let resetNotice = ''
        for (const d of details) {
          if (d?.metadata?.quotaResetDelay) {
            resetNotice = ` (refresh dalam ${d.metadata.quotaResetDelay})`
            break
          }
        }
        throw new Error(
          `Batas kuota Antigravity untuk model "${modelName}" tercapai${resetNotice}. Kamu bisa memilih model lain seperti Claude Sonnet 4.6 di Pengaturan.`
        )
      }

      if (res.status === 401) {
        throw new Error('Sesi Google OAuth kedaluwarsa. Silakan masuk ulang dengan Google di Pengaturan.')
      }

      lastError = new Error(errMsg)
    } catch (e) {
      if (signal?.aborted) throw new Error('Dibatalkan')
      const m = (e as Error)?.message ?? String(e)
      if (/Batas kuota Antigravity|Sesi Google OAuth/i.test(m)) {
        throw e
      }
      lastError = e as Error
    }
  }

  throw lastError ? friendly(lastError) : new Error('Gagal menghubungi Google Antigravity.')
}

export async function testKey(_key?: string, _urlOverride?: string): Promise<KeyTestResult> {
  const oauth = getOAuthStatus()
  if (!oauth.connected) {
    return { ok: false, message: 'Belum masuk ke Google OAuth. Klik Masuk dengan Google di Pengaturan.' }
  }
  const token = await getValidAccessToken()
  if (!token) {
    return { ok: false, message: 'Sesi Google OAuth kedaluwarsa. Silakan masuk ulang dengan Google.' }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)

    const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.107.0',
        'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'Client-Metadata': '{"ideType":"ANTIGRAVITY"}'
      },
      body: JSON.stringify({ project: 'rising-fact-p41fc' }),
      signal: controller.signal
    })
    clearTimeout(timer)

    if (res.ok) {
      return { ok: true, message: `Terhubung ke Google Antigravity (${oauth.email || 'Aktif'})` }
    }
    if (res.status === 401) {
      return { ok: false, message: 'Autentikasi Google OAuth ditolak (401). Silakan masuk ulang di Pengaturan.' }
    }
    return { ok: true, message: `Terhubung via Google OAuth (${oauth.email || 'Aktif'})` }
  } catch (e) {
    return { ok: false, message: friendly(e).message }
  }
}

export function listVoices(): VoiceOption[] {
  return GEMINI_VOICES.map((v) => ({
    id: v.id,
    name: geminiVoiceName(v.id),
    description: geminiVoiceTone(v.id) ?? v.tone
  }))
}

export async function listModels(kind: 'text' | 'image' | 'video' | 'tts'): Promise<ModelOption[]> {
  if (kind === 'image') return ANTIGRAVITY_IMAGE_MODELS
  if (kind === 'video') return ANTIGRAVITY_VIDEO_MODELS
  if (kind === 'tts') return ANTIGRAVITY_TTS_MODELS
  return ANTIGRAVITY_LLM_MODELS
}

/**
 * Structured JSON generation for story scripts and plans using Google Antigravity OAuth.
 */
export async function generateJson(
  model: string,
  system: string,
  prompt: string,
  schema: object,
  signal?: AbortSignal
): Promise<unknown> {
  const token = await getValidAccessToken()
  const rawKey = token || (getSecret('antigravity') ?? '')
  if (!rawKey.trim()) {
    throw new Error('Antigravity belum terhubung ke Google OAuth. Silakan masuk dengan Google di Pengaturan.')
  }

  // If standard Gemini API key (starts with AIza)
  if (rawKey.trim().startsWith('AIza')) {
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': rawKey.trim()
    }
    const geminiBody = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: `${prompt}\n\nBalas HANYA dengan SATU objek JSON yang valid sesuai skema berikut:\n${JSON.stringify(schema)}` }]
        }
      ],
      generationConfig: { responseMimeType: 'application/json' }
    }
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(geminiBody),
      signal
    })
    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as any
      throw new Error(errJson?.error?.message || `HTTP ${res.status}`)
    }
    const json = (await res.json()) as any
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    return extractJson(text)
  }

  const m = model || 'gemini-3.8-flash'
  const requestPayload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [
      {
        role: 'user',
        parts: [{ text: `${prompt}\n\nBalas HANYA dengan SATU objek JSON yang valid sesuai skema berikut:\n${JSON.stringify(schema)}` }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json'
    }
  }

  let data: any
  try {
    data = await callAntigravityApi('generateContent', m, requestPayload, signal)
  } catch (err: any) {
    // If Gemini hits its 5h rate limit, seamlessly fall back to Claude Sonnet 4.6 on Antigravity
    const isQuotaErr = /Batas kuota Antigravity|quota|exhausted|429/i.test(err?.message || '')
    if (isQuotaErr && !m.toLowerCase().startsWith('claude')) {
      try {
        data = await callAntigravityApi('generateContent', 'claude-sonnet-4-6', requestPayload, signal)
      } catch {
        throw err
      }
    } else {
      throw err
    }
  }

  const parts = data?.response?.candidates?.[0]?.content?.parts || data?.candidates?.[0]?.content?.parts || []
  const textPart = parts.find((p: any) => p.text)
  const text = textPart?.text ?? ''
  if (!text) {
    throw new Error('Model Antigravity tidak mengembalikan teks jawaban.')
  }
  try {
    return extractJson(text)
  } catch {
    return JSON.parse(text)
  }
}

/**
 * Generates an image using Google Antigravity Image generation.
 */
export async function generateImage(
  prompt: string,
  aspect: AspectRatio,
  modelId?: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const token = await getValidAccessToken()
  const rawKey = token || (getSecret('antigravity') ?? '')
  if (!rawKey.trim()) {
    throw new Error('Antigravity belum terhubung ke Google OAuth. Silakan masuk dengan Google di Pengaturan.')
  }

  // If using standard Gemini API key (starts with AIza)
  if (rawKey.trim().startsWith('AIza')) {
    const model = modelId || getSettings().antigravityImageModel || 'imagen-3.0-generate-002'
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': rawKey.trim()
    }
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model}:predict`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: aspect }
      }),
      signal
    })
    if (res.ok) {
      const data = (await res.json()) as any
      const b64 = data?.predictions?.[0]?.bytesBase64Encoded || data?.data?.[0]?.b64_json
      if (b64) return { bytes: Buffer.from(b64, 'base64'), contentType: 'image/png' }
    }
  }

  const model = modelId || getSettings().antigravityImageModel || 'gemini-3.1-flash-image'
  const requestPayload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: `${prompt}, full-bleed composition, aspect ratio ${aspect}` }]
      }
    ],
    generationConfig: {
      candidateCount: 1,
      imageConfig: { aspectRatio: aspect }
    }
  }

  const data = await callAntigravityApi('generateContent', model, requestPayload, signal)
  const parts = data?.response?.candidates?.[0]?.content?.parts || data?.candidates?.[0]?.content?.parts || []
  const imagePart = parts.find((p: any) => p.inlineData?.data)
  if (imagePart?.inlineData?.data) {
    return {
      bytes: Buffer.from(imagePart.inlineData.data, 'base64'),
      contentType: imagePart.inlineData.mimeType || 'image/png'
    }
  }

  throw new Error('Google Antigravity tidak mengembalikan data gambar.')
}

/**
 * Generates video using Google Veo with Antigravity / Google OAuth.
 */
export async function generateVideo(
  prompt: string,
  imageInput: Buffer | string,
  aspect: AspectRatio,
  durationSec = 5,
  modelId?: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const token = await getValidAccessToken()
  const rawKey = token || (getSecret('antigravity') ?? '')
  if (!rawKey.trim()) {
    throw new Error('Antigravity belum terhubung ke Google OAuth. Silakan masuk dengan Google di Pengaturan.')
  }

  const model = modelId || getSettings().antigravityVideoModel || 'veo-2.0-generate-001'
  const b64Image =
    typeof imageInput === 'string' && !imageInput.startsWith('http')
      ? imageInput
      : Buffer.isBuffer(imageInput)
        ? imageInput.toString('base64')
        : null

  // If using standard Gemini API key (starts with AIza)
  if (rawKey.trim().startsWith('AIza')) {
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': rawKey.trim()
    }
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model}:predict`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instances: [{ prompt, image: b64Image ? { bytesBase64Encoded: b64Image } : undefined }],
        parameters: { durationSeconds: durationSec, aspectRatio: aspect }
      }),
      signal
    })
    if (res.ok) {
      const data = (await res.json()) as any
      const b64 = data?.predictions?.[0]?.bytesBase64Encoded || data?.video
      if (b64) return { bytes: Buffer.from(b64, 'base64'), contentType: 'video/mp4' }
    }
  }

  // Antigravity Veo predict request
  const requestPayload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          ...(b64Image ? [{ inlineData: { mimeType: 'image/png', data: b64Image } }] : [])
        ]
      }
    ],
    generationConfig: {
      durationSeconds: durationSec,
      aspectRatio: aspect
    }
  }

  try {
    const data = await callAntigravityApi('generateContent', model, requestPayload, signal)
    const parts = data?.response?.candidates?.[0]?.content?.parts || data?.candidates?.[0]?.content?.parts || []
    const videoPart = parts.find((p: any) => p.inlineData?.data)
    if (videoPart?.inlineData?.data) {
      return {
        bytes: Buffer.from(videoPart.inlineData.data, 'base64'),
        contentType: videoPart.inlineData.mimeType || 'video/mp4'
      }
    }
    const url = data?.predictions?.[0]?.url || data?.url
    if (url) {
      const dl = await downloadTo(url, signal)
      return { bytes: dl.bytes, contentType: dl.contentType || 'video/mp4' }
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }

  throw new Error('Google Veo di Antigravity saat ini belum menghasilkan video. Kamu bisa menggunakan Higgsfield untuk video.')
}

function splitSentenceChunks(text: string, maxLen = 150): string[] {
  const parts: string[] = []
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
  for (const s of sentences) {
    const trimmed = s.trim()
    if (!trimmed) continue
    if (trimmed.length <= maxLen) {
      parts.push(trimmed)
    } else {
      const words = trimmed.split(/\s+/)
      let cur = ''
      for (const w of words) {
        if ((cur + ' ' + w).trim().length <= maxLen) {
          cur = (cur + ' ' + w).trim()
        } else {
          if (cur) parts.push(cur)
          cur = w
        }
      }
      if (cur) parts.push(cur)
    }
  }
  return parts
}

async function synthesizeGoogleTts(text: string, lang = 'id', signal?: AbortSignal): Promise<Buffer> {
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal
  })
  if (!res.ok) throw new Error(`Google TTS gagal dengan kode status ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function makeSilenceWav(durationSec: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      binPath(ffmpegStatic!),
      ['-hide_banner', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(durationSec), '-f', 'wav', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout as unknown as Buffer)
      }
    )
  })
}

function mp3To24kWav(mp3Buf: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = execFile(
      binPath(ffmpegStatic!),
      ['-hide_banner', '-i', 'pipe:0', '-f', 'wav', '-ac', '1', '-ar', '24000', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (signal?.aborted) return reject(new Error('Dibatalkan'))
        if (err) reject(err)
        else resolve(stdout as unknown as Buffer)
      }
    )
    if (signal) {
      signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true })
    }
    p.stdin?.write(mp3Buf)
    p.stdin?.end()
  })
}

function concatWavBuffers(wavBuffers: Buffer[]): Buffer {
  if (wavBuffers.length === 0) return Buffer.alloc(0)
  if (wavBuffers.length === 1) return wavBuffers[0]
  const pcmChunks = wavBuffers.map((b) => b.subarray(44))
  const combinedPcm = Buffer.concat(pcmChunks)
  const header = Buffer.alloc(44)
  const dataLen = combinedPcm.length
  const fileLen = dataLen + 36
  header.write('RIFF', 0)
  header.writeUInt32LE(fileLen, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataLen, 40)
  return Buffer.concat([header, combinedPcm])
}

async function synthesizeAntigravityTts(
  text: string,
  languageCode: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const lang = (languageCode || 'id').toLowerCase().split(/[-_]/)[0]
  const rawParts = text.split(/(<long pause>|<short pause>|\n+)/g).filter((p) => p && p.trim())
  const wavBuffers: Buffer[] = []

  for (const part of rawParts) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    const trimmed = part.trim()
    if (!trimmed) continue
    if (trimmed === '<long pause>') {
      wavBuffers.push(await makeSilenceWav(1.2))
    } else if (trimmed === '<short pause>') {
      wavBuffers.push(await makeSilenceWav(0.4))
    } else {
      const clean = trimmed.replace(/<[^>]+>/g, '').trim()
      if (!clean) continue
      const chunks = splitSentenceChunks(clean, 150)
      for (const chunk of chunks) {
        if (signal?.aborted) throw new Error('Dibatalkan')
        const mp3 = await synthesizeGoogleTts(chunk, lang, signal)
        const wav = await mp3To24kWav(mp3, signal)
        wavBuffers.push(wav)
      }
    }
  }

  if (wavBuffers.length === 0) {
    throw new Error('Teks narasi kosong.')
  }

  return concatWavBuffers(wavBuffers)
}

/**
 * Generates speech audio using Google TTS via Antigravity OAuth or Gemini API Key.
 * Returns standard 24kHz mono 16-bit WAV audio buffer.
 */
export async function speak(
  text: string,
  voice: string,
  languageCode: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const token = await getValidAccessToken()
  const rawKey = token || (getSecret('antigravity') ?? '')
  if (!rawKey.trim()) {
    throw new Error('Antigravity belum terhubung ke Google OAuth. Silakan masuk dengan Google di Pengaturan.')
  }

  // If using standard Gemini API key (starts with AIza)
  if (rawKey.trim().startsWith('AIza')) {
    const model = getSettings().antigravityTtsModel || 'gemini-2.5-flash'
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': rawKey.trim()
    }
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice || 'Charon' }
            }
          }
        }
      }),
      signal
    })
    if (res.ok) {
      const data = (await res.json()) as any
      const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
      if (b64) {
        const raw = Buffer.from(b64, 'base64')
        return isWav(raw) ? raw : pcmToWav(raw)
      }
    }
  }

  // Antigravity Google TTS pipeline with high-precision pause & silence generation
  return synthesizeAntigravityTts(text, languageCode, signal)
}
