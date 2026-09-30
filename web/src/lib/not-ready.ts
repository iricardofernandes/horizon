/**
 * A module that has not yet provisioned a new workspace answers `503` with `Retry-After`
 * (Phase 80). The web waits and asks again, a few times, when asking again cannot apply a
 * write twice: a read, or a write that carries an idempotency key.
 */

export const NOT_READY_ATTEMPTS = 4
/** The longest wait honoured, whatever the upstream asks for. */
export const NOT_READY_MAX_WAIT_MS = 5_000

export function mayAskAgain(method: string, headers: Headers): boolean {
  return ['GET', 'HEAD'].includes(method.toUpperCase()) || headers.has('idempotency-key')
}

/** The wait a `503` asks for, in milliseconds, or null when it is not a wait at all. */
export function notReadyWait(response: Pick<Response, 'status' | 'headers'>): number | null {
  if (response.status !== 503) return null
  const header = response.headers.get('retry-after')
  if (header === null) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, NOT_READY_MAX_WAIT_MS)
}

export async function askUntilReady(
  send: () => Promise<Response>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  let response = await send()
  for (let attempt = 1; attempt < NOT_READY_ATTEMPTS; attempt++) {
    const ms = notReadyWait(response)
    if (ms === null) return response
    await wait(ms)
    response = await send()
  }
  return response
}
