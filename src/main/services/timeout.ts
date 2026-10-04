/**
 * Deadlines for calls that otherwise never return.
 *
 * Two waits in this app had no bound at all, and both produce the same user-visible symptom: a job
 * that spins forever with no error, because the panel keeps showing the last progress it was told
 * about. Neither case is exotic:
 *
 *   - `fetch()` has no default timeout. A socket that stalls mid-body — a multi-megabyte Flow image
 *     upload, a token refresh behind a captive portal — stays open indefinitely.
 *   - `webContents.executeJavaScript()` settles only when the page's script settles. If that script
 *     awaits a stalled fetch, or the renderer never becomes responsive, the promise never settles,
 *     and every deadline the caller set around *other* work is never re-evaluated.
 *
 * Everything that touches the network or a page goes through this module.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} tidak merespons setelah ${Math.round(ms / 1000)} detik`)
    this.name = 'TimeoutError'
  }
}

/**
 * Reject if `work` has not settled within `ms`.
 *
 * The losing promise keeps running — a promise cannot be cancelled — so prefer the abort-aware
 * helpers below when the operation can actually be killed.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `fetch` with a real deadline: the request is aborted, not merely abandoned. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 20_000,
  label = 'Permintaan jaringan'
): Promise<Response> {
  const ctrl = new AbortController()
  const outer = init.signal ?? null
  let timedOut = false

  if (outer?.aborted) {
    const aborted = new Error('Dibatalkan')
    aborted.name = 'AbortError'
    throw aborted
  }
  const forward = () => ctrl.abort()
  outer?.addEventListener('abort', forward, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, ms)

  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (timedOut) throw new TimeoutError(label, ms)
    throw e
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  }
}

/** True when `e` came from a deadline rather than from the peer. */
export function isTimeout(e: unknown): boolean {
  return e instanceof TimeoutError || (e instanceof Error && e.name === 'TimeoutError')
}
