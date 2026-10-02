import { AspectRatio, KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
import { GEMINI_VOICES, geminiVoiceName, geminiVoiceTone } from '@shared/models'
import {
  ANTIGRAVITY_IMAGE_MODELS,
  ANTIGRAVITY_VIDEO_MODELS,
  ANTIGRAVITY_TTS_MODELS,
  ANTIGRAVITY_LLM_MODELS
} from '@shared/antigravity'
import { getSecret } from '../secrets'
import { getSettings } from '../settings'
import { isWav, pcmToWav } from './audio'
import { downloadTo, sleep } from './http'
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

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com'

async function getAuthHeader(): Promise<Record<string, string>> {
  const token = await getValidAccessToken()
  const rawKey = token || (getSecret('antigravity') ?? '')
  if (!rawKey.trim()) {
    throw new Error('Antigravity belum terhubung ke Google OAuth. Silakan masuk dengan Google di Pengaturan.')
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${rawKey.trim()}`
  }
  if (rawKey.trim().startsWith('AIza')) {
    headers['x-goog-api-key'] = rawKey.trim()
  }
  return headers
}

function friendly(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e)
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return new Error('Gagal terhubung ke Google. Periksa koneksi internet kamu.')
  }
  if (/401|403|unauthorized|forbidden/i.test(msg)) {
    return new Error('Autentikasi Google OAuth ditolak. Masuk ulang Google OAuth di Pengaturan.')
  }
  if (/429|quota|rate limit/i.test(msg)) {
    return new Error('Batas permintaan Google tercapai. Coba lagi sebentar.')
  }
  return new Error(`Antigravity gagal: ${msg}`)
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
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    clearTimeout(timer)

    if (res.ok) {
      return { ok: true, message: `Terhubung via Google OAuth (${oauth.email || 'Aktif'})` }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Autentikasi Google OAuth ditolak (401/403). Silakan masuk ulang di Pengaturan.' }
    }
    return { ok: true, message: `Terhubung ke Google (${res.status})` }
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

  const curated = kind === 'text' ? ANTIGRAVITY_LLM_MODELS : ANTIGRAVITY_TTS_MODELS
  const token = await getValidAccessToken()
  if (!token) return curated

  try {
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models?pageSize=200`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) return curated
    const json = (await res.json()) as any
    const list: any[] = json?.models ?? []
    const live: ModelOption[] = []

    const NOT_TEXT = /embedding|imagen|image|veo|native-audio|live|aqa|transcribe|robotics|computer-use|lyria/i

    for (const m of list) {
      const id = (m.name ?? '').replace(/^models\//, '')
      if (!id) continue
      const methods: string[] = m.supportedGenerationMethods ?? []
      if (!methods.includes('generateContent')) continue
      const isTts = /tts/i.test(id)
      if (kind === 'tts' ? !isTts : (isTts || NOT_TEXT.test(id))) continue

      const matchCurated = curated.find((c) => c.id === id)
      live.push({
        id,
        name: matchCurated?.name || m.displayName || id,
        description: matchCurated?.description || m.description?.slice(0, 280),
        family: 'Gemini',
        tags: matchCurated?.tags || (kind === 'text' && id.startsWith('gemini') ? ['Google', 'JSON'] : ['Google'])
      })
    }

    if (!live.length) return curated

    for (const c of curated) {
      if (!live.some((l) => l.id === c.id)) {
        live.push(c)
      }
    }

    return live.sort((a, b) => {
      const ga = a.id.startsWith('gemini') ? 0 : 1
      const gb = b.id.startsWith('gemini') ? 0 : 1
      return ga - gb || b.id.localeCompare(a.id, 'en', { numeric: true })
    })
  } catch {
    return curated
  }
}

/**
 * Structured JSON generation for story scripts and plans using Google Gemini API directly with OAuth.
 */
export async function generateJson(
  model: string,
  system: string,
  prompt: string,
  schema: object,
  signal?: AbortSignal
): Promise<unknown> {
  const headers = await getAuthHeader()
  const m = model || 'gemini-2.5-flash'

  const geminiBody = {
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

  try {
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(geminiBody),
      signal
    })

    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as any
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`
      throw new Error(errMsg)
    }

    const json = (await res.json()) as any
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    if (!text) {
      throw new Error('Model tidak mengembalikan teks jawaban.')
    }
    try {
      return extractJson(text)
    } catch {
      return JSON.parse(text)
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

/**
 * Generates an image using Google Imagen directly with OAuth.
 */
export async function generateImage(
  prompt: string,
  aspect: AspectRatio,
  modelId?: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const headers = await getAuthHeader()
  const model = modelId || getSettings().antigravityImageModel || 'imagen-3.0-generate-002'

  try {
    // Attempt 1: predict endpoint
    let res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model}:predict`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: aspect }
      }),
      signal
    })

    // Attempt 2: generateImages endpoint
    if (!res.ok) {
      res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model}:generateImages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt,
          numberOfImages: 1,
          aspectRatio: aspect,
          outputMimeType: 'image/png'
        }),
        signal
      })
    }

    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as any
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`
      throw new Error(errMsg)
    }

    const data = (await res.json()) as any
    const b64 =
      data?.predictions?.[0]?.bytesBase64Encoded ||
      data?.generatedImages?.[0]?.image?.imageBytes ||
      data?.data?.[0]?.b64_json ||
      data?.images?.[0]?.image ||
      data?.image

    if (b64) {
      return { bytes: Buffer.from(b64, 'base64'), contentType: 'image/png' }
    }

    const url = data?.data?.[0]?.url || data?.predictions?.[0]?.url
    if (url) {
      const dl = await downloadTo(url, signal)
      return { bytes: dl.bytes, contentType: dl.contentType || 'image/png' }
    }

    throw new Error('Google Imagen tidak mengembalikan gambar atau base64 yang valid.')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

/**
 * Generates video using Google Veo directly with OAuth.
 */
export async function generateVideo(
  prompt: string,
  imageInput: Buffer | string,
  aspect: AspectRatio,
  durationSec = 5,
  modelId?: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const headers = await getAuthHeader()
  const model = modelId || getSettings().antigravityVideoModel || 'veo-2.0-generate-001'

  const b64Image =
    typeof imageInput === 'string' && !imageInput.startsWith('http')
      ? imageInput
      : Buffer.isBuffer(imageInput)
        ? imageInput.toString('base64')
        : null

  try {
    const res = await fetch(`${GOOGLE_API_BASE}/v1beta/models/${model}:predict`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instances: [
          {
            prompt,
            image: b64Image ? { bytesBase64Encoded: b64Image } : undefined
          }
        ],
        parameters: { durationSeconds: durationSec, aspectRatio: aspect }
      }),
      signal
    })

    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as any
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`
      throw new Error(errMsg)
    }

    const data = (await res.json()) as any
    const b64 =
      data?.predictions?.[0]?.bytesBase64Encoded ||
      data?.video ||
      data?.data?.[0]?.b64_json

    if (b64) {
      return { bytes: Buffer.from(b64, 'base64'), contentType: 'video/mp4' }
    }

    let url = data?.predictions?.[0]?.url || data?.data?.[0]?.url || data?.url
    const opId = data?.name || data?.id
    if (!url && opId) {
      const started = Date.now()
      while (Date.now() - started < 15 * 60 * 1000) {
        await sleep(3000, signal)
        const check = await fetch(`${GOOGLE_API_BASE}/v1/operations/${opId}`, { headers, signal })
        if (check.ok) {
          const pollData = (await check.json()) as any
          if (pollData?.done) {
            url = pollData?.response?.videoUri || pollData?.response?.url
            break
          }
        }
      }
    }

    if (url) {
      const dl = await downloadTo(url, signal)
      return { bytes: dl.bytes, contentType: dl.contentType || 'video/mp4' }
    }

    throw new Error('Google Veo tidak mengembalikan video yang selesai.')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

/**
 * Generates speech audio using Google Gemini TTS directly with OAuth.
 * Returns WAV audio buffer.
 */
export async function speak(
  text: string,
  voice: string,
  _languageCode: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const headers = await getAuthHeader()
  const model = getSettings().antigravityTtsModel || 'gemini-2.5-flash'

  try {
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

    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as any
      const errMsg = errJson?.error?.message || `HTTP ${res.status}`
      throw new Error(errMsg)
    }

    const data = (await res.json()) as any
    const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData
    const b64 = inlineData?.data
    if (b64) {
      const raw = Buffer.from(b64, 'base64')
      return isWav(raw) ? raw : pcmToWav(raw)
    }

    throw new Error('Google Gemini TTS tidak mengembalikan data audio.')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}
