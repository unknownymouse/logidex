import type { ModelOption } from './types'

export const DEFAULT_ANTIGRAVITY_IMAGE_MODEL = 'imagen-3.0-generate-002'
export const DEFAULT_ANTIGRAVITY_VIDEO_MODEL = 'veo-2.0-generate-001'
export const DEFAULT_ANTIGRAVITY_TTS_MODEL = 'gemini-3.8-flash-tts'
export const DEFAULT_ANTIGRAVITY_LLM_MODEL = 'gemini-3.8-flash'

export const ANTIGRAVITY_LLM_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Model Gemini 3.8 generasi terbaru, sangat cepat, cerdas, dan menghasilkan naskah cerita terstruktur rapi.',
    family: 'Gemini',
    tags: ['Google', 'Rekomendasi', 'JSON', 'Terbaru']
  },
  {
    id: 'gemini-3.8-pro',
    name: 'Gemini 3.8 Pro',
    description: 'Model penalaran tertinggi Google Gemini 3.8 untuk alur naskah dramatis, kaya emosi, dan rencana visual mendalam.',
    family: 'Gemini',
    tags: ['Google', 'Pintar', 'JSON', 'Terbaru']
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    description: 'Model penalaran cerdas Claude Sonnet 4.6 via Antigravity dengan kuota independen dan naskah sangat deskriptif.',
    family: 'Claude',
    tags: ['Antigravity', 'Thinking', 'Rekomendasi', 'JSON']
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (Thinking)',
    description: 'Model penalaran mendalam Claude Opus 4.6 via Antigravity untuk penulisan alur cerita kompleks.',
    family: 'Claude',
    tags: ['Antigravity', 'Thinking', 'JSON']
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (Medium)',
    description: 'Model open-source performa tinggi via Antigravity dengan penulisan naskah yang luwes.',
    family: 'OpenAI',
    tags: ['Antigravity', 'JSON']
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    description: 'Model Gemini 3.5 seimbang, cepat dan hemat pemrosesan.',
    family: 'Gemini',
    tags: ['Google', 'JSON', 'Cepat']
  },
  {
    id: 'gemini-3.5-pro',
    name: 'Gemini 3.5 Pro',
    description: 'Model Gemini 3.5 Pro dengan kemampuan analisis narasi tinggi.',
    family: 'Gemini',
    tags: ['Google', 'JSON', 'Pintar']
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: 'Model multimodal stabil dan cepat untuk penulisan skrip.',
    family: 'Gemini',
    tags: ['Google', 'JSON', 'Cepat']
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: 'Penalaran cerita mendalam dan penulisan naskah yang terstruktur.',
    family: 'Gemini',
    tags: ['Google', 'JSON', 'Pintar']
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    description: 'Generasi naskah ultra-cepat dan efisien.',
    family: 'Gemini',
    tags: ['Google', 'JSON', 'Cepat']
  },
  {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash Lite',
    description: 'Model ringan hemat kuota untuk respons cepat.',
    family: 'Gemini',
    tags: ['Google', 'JSON']
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    description: 'Model penalaran panjang klasik Google.',
    family: 'Gemini',
    tags: ['Google', 'JSON']
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    description: 'Model cepat serbaguna Gemini 1.5.',
    family: 'Gemini',
    tags: ['Google', 'JSON']
  }
]

export const ANTIGRAVITY_IMAGE_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.1-flash-image',
    name: 'Gemini 3.1 Flash Image',
    description: 'Generasi gambar cepat dan tajam Google Gemini 3.1 via Antigravity.',
    family: 'Gemini',
    tags: ['Google', 'Antigravity', 'HQ', 'Rekomendasi', 'Terbaru']
  },
  {
    id: 'imagen-3.0-generate-002',
    name: 'Imagen 3 · Standard',
    description: 'Generasi gambar kualitas tinggi dengan detail tajam dan kepatuhan prompt presisi.',
    family: 'Imagen',
    tags: ['Google', 'Antigravity', 'HQ']
  },
  {
    id: 'imagen-3.0-fast-generate-001',
    name: 'Imagen 3 · Fast',
    description: 'Generasi gambar cepat dengan efisiensi maksimal.',
    family: 'Imagen',
    tags: ['Google', 'Cepat']
  }
]

export const ANTIGRAVITY_VIDEO_MODELS: ModelOption[] = [
  {
    id: 'veo-2.0-generate-001',
    name: 'Veo 2 · Standard',
    description: 'Generasi video AI sinematik dengan gerak alami dan resolusi tinggi.',
    family: 'Veo',
    tags: ['Google', 'Antigravity', 'Video', 'Rekomendasi']
  },
  {
    id: 'veo-2.0-fast-generate-001',
    name: 'Veo 2 · Fast',
    description: 'Generasi video AI dengan proses lebih cepat.',
    family: 'Veo',
    tags: ['Google', 'Cepat']
  }
]

export const ANTIGRAVITY_TTS_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.8-flash-tts',
    name: 'Gemini 3.8 Flash TTS',
    description: 'Narasi suara natural generasi terbaru Google Gemini 3.8 dengan intonasi dinamis.',
    family: 'Gemini',
    tags: ['TTS', 'Natural', 'Terbaru', 'Rekomendasi']
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash Audio',
    description: 'Audio dan narasi suara generasi 3.8.',
    family: 'Gemini',
    tags: ['TTS', 'Multimodal']
  },
  {
    id: 'gemini-3.5-flash-tts',
    name: 'Gemini 3.5 Flash TTS',
    description: 'Narasi suara natural Google Gemini 3.5.',
    family: 'Gemini',
    tags: ['TTS', 'Natural']
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash Audio',
    description: 'Audio dan narasi suara natural Google Gemini 2.5.',
    family: 'Gemini',
    tags: ['TTS', 'Natural']
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash Audio',
    description: 'Audio dan suara cepat mendukung multispeech.',
    family: 'Gemini',
    tags: ['TTS', 'Cepat']
  }
]

export function getAntigravityImageModel(id?: string | null): ModelOption {
  return ANTIGRAVITY_IMAGE_MODELS.find((m) => m.id === id) ?? ANTIGRAVITY_IMAGE_MODELS[0]
}

export function getAntigravityVideoModel(id?: string | null): ModelOption {
  return ANTIGRAVITY_VIDEO_MODELS.find((m) => m.id === id) ?? ANTIGRAVITY_VIDEO_MODELS[0]
}

export function getAntigravityLlmModel(id?: string | null): ModelOption {
  return ANTIGRAVITY_LLM_MODELS.find((m) => m.id === id) ?? ANTIGRAVITY_LLM_MODELS[0]
}
