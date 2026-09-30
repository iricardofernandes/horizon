import { afterEach, describe, expect, it, vi } from 'vitest'

const tracedFetch = vi.fn()
vi.mock('@/lib/telemetry', () => ({ tracedFetch: (...args: unknown[]) => tracedFetch(...args) }))

const { readJsonIfAllowed, ResourceUnavailableError, SessionExpiredError } = await import('./api')

const answer = (status: number, body: unknown = null) =>
  new Response(body === null ? null : JSON.stringify(body), { status })

describe('a read the person may not be allowed', () => {
  afterEach(() => tracedFetch.mockReset())

  it('returns what was read', async () => {
    tracedFetch.mockResolvedValue(answer(200, [{ id: 'w1' }]))
    expect(await readJsonIfAllowed('inventory.warehouses', '/x')).toEqual([{ id: 'w1' }])
  })

  it('is null when the person’s roles refuse it, so the screen does without it', async () => {
    tracedFetch.mockResolvedValue(answer(403, { title: 'Forbidden' }))
    expect(await readJsonIfAllowed('inventory.warehouses', '/x')).toBeNull()
  })

  it('still fails on an expired session or an unavailable service', async () => {
    tracedFetch.mockResolvedValue(answer(401))
    await expect(readJsonIfAllowed('n', '/x')).rejects.toBeInstanceOf(SessionExpiredError)
    tracedFetch.mockResolvedValue(answer(502))
    await expect(readJsonIfAllowed('n', '/x')).rejects.toBeInstanceOf(ResourceUnavailableError)
  })
})
