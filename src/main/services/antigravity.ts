import { AspectRatio, KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
import { GEMINI_VOICES, geminiVoiceName, geminiVoiceTone } from '@shared/models'
import { getSecret } from '../secrets'
import { getSettings } from '../settings'
import { isWav, pcmToWav } from './audio'
import { downloadTo, sleep } from './http'

function baseUrl(override?: string): string {
  const raw = override ?? getSettings().antigravityBaseUrl ?? 'http://127.0.0.1:8045'
  return raw.trim().replace(/\/+$/, '')
}

function authHeaders(keyOverride?: string): Record<string, string> {
  const key = keyOverride !== undefined ? keyOverride : (getSecret('antigravity') ?? '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key.trim()) {
    headers['Authorization'] = `Bearer ${key.trim()}`
    headers['x-goog-api-key'] = key.trim()
  }
  return headers
}

function friendly(e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e)
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return new Error('Tidak bisa terhubung ke Antigravity Proxy. Pastikan proxy lokal (@cortexkit/antigravity-auth atau proxy lainnya) sudah berjalan.')
  }
  if (/401|403|unauthorized|forbidden/i.test(msg)) {
    return new Error('Autentikasi Antigravity ditolak. Periksa kunci / token di Pengaturan.')
  }
  if (/429|quota|rate limit/i.test(msg)) {
    return new Error('Batas permintaan Antigravity tercapai. Coba lagi sebentar.')
  }
  return new Error(`Antigravity gagal: ${msg}`)
}

export async function testKey(key?: string, urlOverride?: string): Promise<KeyTestResult> {
  const base = baseUrl(urlOverride)
  const headers = authHeaders(key)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    // Check models endpoint or root endpoint
    let res: Response
    try {
      res = await fetch(`${base}/v1/models`, { headers, signal: controller.signal })
    } catch {
      res = await fetch(`${base}/models`, { headers, signal: controller.signal })
    }
    clearTimeout(timer)
    if (res.ok) {
      return { ok: true, message: `Terhubung ke Antigravity Proxy (${base})` }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Autentikasi ditolak (401/403). Periksa kunci atau login OAuth di proxy.' }
    }
    return { ok: true, message: `Terhubung ke Antigravity (${res.status})` }
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

export {
  ANTIGRAVITY_IMAGE_MODELS,
  ANTIGRAVITY_VIDEO_MODELS,
  ANTIGRAVITY_TTS_MODELS,
  getAntigravityImageModel,
  getAntigravityVideoModel
} from '@shared/antigravity'
import {
  ANTIGRAVITY_IMAGE_MODELS,
  ANTIGRAVITY_VIDEO_MODELS,
  ANTIGRAVITY_TTS_MODELS
} from '@shared/antigravity'

export function listModels(kind: 'image' | 'video' | 'tts'): ModelOption[] {
  if (kind === 'image') return ANTIGRAVITY_IMAGE_MODELS
  if (kind === 'video') return ANTIGRAVITY_VIDEO_MODELS
  return ANTIGRAVITY_TTS_MODELS
}

/**
 * Generates an image using the local Antigravity proxy.
 * Supports OpenAI /v1/images/generations or Google predict formats.
 */
export async function generateImage(
  prompt: string,
  aspect: AspectRatio,
  modelId?: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const base = baseUrl()
  const headers = authHeaders()
  const model = modelId || getSettings().antigravityImageModel || 'imagen-3.0-generate-002'

  // Map aspect ratio to dimensions if needed
  const size = aspect === '9:16' ? '768x1344' : '1344x768'

  try {
    // Attempt 1: Standard OpenAI image generations format
    let res = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        aspect_ratio: aspect,
        response_format: 'b64_json'
      }),
      signal
    })

    if (!res.ok) {
      // Attempt 2: Google GenAI predict / generateImages format
      res = await fetch(`${base}/v1beta/models/${model}:predict`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio: aspect }
        }),
        signal
      })
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`)
    }

    const data = (await res.json()) as any
    // Parse response
    const b64 =
      data?.data?.[0]?.b64_json ||
      data?.predictions?.[0]?.bytesBase64Encoded ||
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

    throw new Error('Proxy Antigravity tidak mengembalikan gambar atau base64 yang valid')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

/**
 * Generates video using the Antigravity proxy.
 */
export async function generateVideo(
  prompt: string,
  imageInput: Buffer | string,
  aspect: AspectRatio,
  durationSec = 5,
  modelId?: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string }> {
  const base = baseUrl()
  const headers = authHeaders()
  const model = modelId || getSettings().antigravityVideoModel || 'veo-2.0-generate-001'

  const b64Image = typeof imageInput === 'string' && !imageInput.startsWith('http')
    ? imageInput
    : Buffer.isBuffer(imageInput)
      ? imageInput.toString('base64')
      : null

  try {
    // Attempt OpenAI /v1/videos/generations or Google Veo predict
    let res = await fetch(`${base}/v1/videos/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        prompt,
        image: b64Image ? `data:image/png;base64,${b64Image}` : (typeof imageInput === 'string' ? imageInput : undefined),
        duration: durationSec,
        aspect_ratio: aspect
      }),
      signal
    })

    if (!res.ok) {
      res = await fetch(`${base}/v1beta/models/${model}:predict`, {
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
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`)
    }

    const data = (await res.json()) as any
    const b64 =
      data?.data?.[0]?.b64_json ||
      data?.predictions?.[0]?.bytesBase64Encoded ||
      data?.video

    if (b64) {
      return { bytes: Buffer.from(b64, 'base64'), contentType: 'video/mp4' }
    }

    let url = data?.data?.[0]?.url || data?.predictions?.[0]?.url || data?.url
    // If it returns an operation ID, poll until complete
    const opId = data?.name || data?.id
    if (!url && opId) {
      const started = Date.now()
      while (Date.now() - started < 15 * 60 * 1000) {
        await sleep(3000, signal)
        const check = await fetch(`${base}/v1/operations/${opId}`, { headers, signal })
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

    throw new Error('Proxy Antigravity tidak mengembalikan video yang selesai')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

/**
 * Generates speech audio using the Antigravity proxy.
 * Returns WAV audio buffer.
 */
export async function speak(
  text: string,
  voice: string,
  _languageCode: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const base = baseUrl()
  const headers = authHeaders()
  const model = getSettings().antigravityTtsModel || 'gemini-2.5-flash'

  try {
    // Attempt 1: OpenAI compatible /v1/audio/speech
    let res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: text,
        voice: voice || 'Charon',
        response_format: 'wav'
      }),
      signal
    })

    if (res.ok) {
      const arrayBuf = await res.arrayBuffer()
      const bytes = Buffer.from(arrayBuf)
      return isWav(bytes) ? bytes : pcmToWav(bytes)
    }

    // Attempt 2: Google GenAI generateContent with audio modality
    res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
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
      const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData
      const b64 = inlineData?.data
      if (b64) {
        const raw = Buffer.from(b64, 'base64')
        return isWav(raw) ? raw : pcmToWav(raw)
      }
    }

    const err = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`)
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}
