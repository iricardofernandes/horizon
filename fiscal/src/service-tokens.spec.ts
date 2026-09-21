import { afterEach, expect, it, vi } from 'vitest'
import { FiscalServiceTokens } from './service-tokens'

const tenantA = '00000000-0000-4000-8000-000000000001'
const tenantB = '00000000-0000-4000-8000-000000000002'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('coalesces exchanges, caches per tenant and refreshes before expiry', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-21T12:00:00Z'))
  let calls = 0
  const fetchMock = vi.fn(async (_url: URL, options: RequestInit) => {
    calls += 1
    const body = JSON.parse(String(options.body)) as { tenantId: string; presented: string }
    expect(body.presented).toBe(body.tenantId === tenantA ? 'key-a' : 'key-b')
    return Response.json({
      tenantId: body.tenantId,
      accessToken: `token-${calls}-${'x'.repeat(20)}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const tokens = new FiscalServiceTokens('http://identity.local', {
    [tenantA]: 'key-a',
    [tenantB]: 'key-b',
  })

  const [first, concurrent] = await Promise.all([
    tokens.forTenant(tenantA),
    tokens.forTenant(tenantA),
  ])
  expect(first).toBe(concurrent)
  expect(await tokens.forTenant(tenantA)).toBe(first)
  expect(await tokens.forTenant(tenantB)).not.toBe(first)
  expect(fetchMock).toHaveBeenCalledTimes(2)

  vi.advanceTimersByTime(14 * 60_000 + 1)
  expect(await tokens.forTenant(tenantA)).not.toBe(first)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('rejects a mismatched tenant and does not cache the response', async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({
      tenantId: tenantB,
      accessToken: `token-${'x'.repeat(20)}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const tokens = new FiscalServiceTokens('http://identity.local', { [tenantA]: 'key-a' })

  await expect(tokens.forTenant(tenantA)).rejects.toThrow('tenant mismatch')
  await expect(tokens.forTenant(tenantA)).rejects.toThrow('tenant mismatch')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
