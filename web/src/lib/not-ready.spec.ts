import { describe, expect, it } from 'vitest'
import { askUntilReady, mayAskAgain, NOT_READY_ATTEMPTS, notReadyWait } from './not-ready'

const answer = (status: number, retryAfter?: string) =>
  new Response(null, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} })

describe('a workspace not ready yet', () => {
  it('asks again only when that cannot apply a write twice', () => {
    expect(mayAskAgain('GET', new Headers())).toBe(true)
    expect(mayAskAgain('post', new Headers({ 'idempotency-key': 'k' }))).toBe(true)
    expect(mayAskAgain('POST', new Headers())).toBe(false)
  })

  it('reads the wait from Retry-After, bounded, and only on 503', () => {
    expect(notReadyWait(answer(503, '2'))).toBe(2000)
    expect(notReadyWait(answer(503, '600'))).toBe(5000)
    expect(notReadyWait(answer(503))).toBeNull()
    expect(notReadyWait(answer(500, '2'))).toBeNull()
  })

  it('asks again until the workspace is ready', async () => {
    const answers = [answer(503, '1'), answer(503, '1'), answer(201)]
    const waits: number[] = []
    const response = await askUntilReady(
      async () => answers.shift() ?? answer(500),
      async (ms) => {
        waits.push(ms)
      },
    )
    expect(response.status).toBe(201)
    expect(waits).toEqual([1000, 1000])
  })

  it('gives up after a few attempts and returns the last answer', async () => {
    let sent = 0
    const response = await askUntilReady(
      async () => {
        sent++
        return answer(503, '1')
      },
      async () => undefined,
    )
    expect(response.status).toBe(503)
    expect(sent).toBe(NOT_READY_ATTEMPTS)
  })
})
