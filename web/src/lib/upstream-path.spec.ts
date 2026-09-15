import { describe, expect, it } from 'vitest'
import { buildUpstreamPath } from './upstream-path'

describe('buildUpstreamPath', () => {
  it('proxies only a known bounded-context root', () => {
    expect(buildUpstreamPath(['sales', 'orders'], '?status=confirmed')).toBe(
      '/sales/orders?status=confirmed',
    )
  })

  it('rejects empty and unknown roots', () => {
    expect(buildUpstreamPath([])).toBeNull()
    expect(buildUpstreamPath(['admin', 'secrets'])).toBeNull()
  })

  it('keeps decoded path segments from becoming path traversal', () => {
    expect(buildUpstreamPath(['sales', '..', 'identity'])).toBeNull()
    expect(buildUpstreamPath(['sales', '.', 'orders'])).toBeNull()
    expect(buildUpstreamPath(['sales', 'orders/other'])).toBe('/sales/orders%2Fother')
  })
})
