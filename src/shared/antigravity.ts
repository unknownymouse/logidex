import type { ModelOption } from './types'

export const DEFAULT_ANTIGRAVITY_IMAGE_MODEL = 'imagen-3.0-generate-002'
export const DEFAULT_ANTIGRAVITY_VIDEO_MODEL = 'veo-2.0-generate-001'
export const DEFAULT_ANTIGRAVITY_TTS_MODEL = 'gemini-2.5-flash'

export const ANTIGRAVITY_IMAGE_MODELS: ModelOption[] = [
  {
    id: 'imagen-3.0-generate-002',
    name: 'Imagen 3 · Standard',
    description: 'Generasi gambar kualitas tinggi dengan detail tajam dan kepatuhan teks presisi.',
    family: 'Imagen',
    tags: ['Google', 'Antigravity', 'HQ']
  },
  {
    id: 'imagen-3.0-fast-generate-001',
    name: 'Imagen 3 · Fast',
    description: 'Generasi gambar cepat dengan konsumsi kuota lebih efisien.',
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
    tags: ['Google', 'Antigravity', 'Video']
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
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash Audio',
    description: 'Audio dan narasi suara natural generasi terbaru dari Google Gemini.',
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
