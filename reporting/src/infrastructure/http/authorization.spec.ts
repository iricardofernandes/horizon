import { describe, expect, it } from 'vitest'
import { permits } from './authorization'

describe('reporting roles', () => {
  it('lets every reporting role read, and no other module role', () => {
    for (const role of ['admin', 'analyst', 'viewer'])
      expect(permits([{ module: 'reporting', role }], 'read')).toBe(true)
    expect(permits([{ module: 'sales', role: 'admin' }], 'read')).toBe(false)
    expect(permits([], 'read')).toBe(false)
  })
})
