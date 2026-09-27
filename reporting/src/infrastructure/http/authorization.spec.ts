import { describe, expect, it } from 'vitest'
import { permits } from './authorization'

describe('reporting roles', () => {
  it('lets every reporting role read, and no other module role', () => {
    for (const role of ['admin', 'analyst', 'viewer'])
      expect(permits([{ module: 'reporting', role }], 'read')).toBe(true)
    expect(permits([{ module: 'sales', role: 'admin' }], 'read')).toBe(false)
    expect(permits([], 'read')).toBe(false)
  })

  it('lets an analyst reconcile and save, and only an administrator share', () => {
    const as = (role: string) => [{ module: 'reporting', role }]
    expect(permits(as('analyst'), 'reconcile')).toBe(true)
    expect(permits(as('analyst'), 'save')).toBe(true)
    expect(permits(as('analyst'), 'share')).toBe(false)
    expect(permits(as('admin'), 'share')).toBe(true)
    expect(permits(as('viewer'), 'reconcile')).toBe(false)
    expect(permits(as('viewer'), 'save')).toBe(false)
  })

  it('lets everyone export, an analyst schedule, and only an administrator see all', () => {
    const as = (role: string) => [{ module: 'reporting', role }]
    expect(permits(as('viewer'), 'export')).toBe(true)
    expect(permits(as('viewer'), 'schedule')).toBe(false)
    expect(permits(as('analyst'), 'schedule')).toBe(true)
    expect(permits(as('analyst'), 'administer')).toBe(false)
    expect(permits(as('admin'), 'administer')).toBe(true)
  })
})
