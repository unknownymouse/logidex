import type { KeyStatus, TtsProvider } from '@shared/types'

export const TTS_NAMES: Record<TtsProvider, string> = {
  gemini: 'Gemini TTS',
  elevenlabs: 'ElevenLabs',
  antigravity: 'Antigravity TTS'
}

/**
 * Whether each narrator voice service can be used: it needs a saved key that did not fail its last check.
 * `reason` says why not, for disabled options.
 */
export function ttsReadiness(keys: KeyStatus[]): Record<TtsProvider, { ok: boolean; reason: string | null }> {
  const one = (p: TtsProvider): { ok: boolean; reason: string | null } => {
    const k = keys.find((x) => x.provider === p)
    const name = p === 'gemini' ? 'Gemini' : p === 'elevenlabs' ? 'ElevenLabs' : 'Antigravity'
    if (!k?.configured) return { ok: false, reason: p === 'antigravity' ? 'Antigravity OAuth belum terhubung' : `Kunci ${name} belum diisi` }
    if (k.lastOk === false) return { ok: false, reason: `Koneksi ${name} tidak valid` }
    return { ok: true, reason: null }
  }
  return { gemini: one('gemini'), elevenlabs: one('elevenlabs'), antigravity: one('antigravity') }
}

/** The preferred provider when it is usable, otherwise another usable one, otherwise the preferred one anyway. */
export function usableTts(preferred: TtsProvider, keys: KeyStatus[]): TtsProvider {
  const ready = ttsReadiness(keys)
  if (ready[preferred]?.ok) return preferred
  const providers: TtsProvider[] = ['gemini', 'elevenlabs', 'antigravity']
  const other = providers.find((p) => p !== preferred && ready[p]?.ok)
  return other ?? preferred
}
