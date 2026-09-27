import { describe, expect, it } from 'vitest'
import { permits } from './authorization'

const as = (role: string) => [{ module: 'crm', role }]

describe('CRM role map', () => {
  it('lets a viewer read and nothing else', () => {
    expect(permits(as('viewer'), 'read')).toBe(true)
    expect(permits(as('viewer'), 'write')).toBe(false)
  })

  it('keeps owner reassignment with managers and erasure with admins', () => {
    expect(permits(as('representative'), 'write')).toBe(true)
    expect(permits(as('representative'), 'assign')).toBe(false)
    expect(permits(as('manager'), 'assign')).toBe(true)
    expect(permits(as('manager'), 'erase')).toBe(false)
    expect(permits(as('admin'), 'erase')).toBe(true)
  })

  it('leaves pipelines and lists to managers and admins', () => {
    expect(permits(as('manager'), 'configure')).toBe(true)
    expect(permits(as('admin'), 'configure')).toBe(true)
    expect(permits(as('representative'), 'configure')).toBe(false)
  })

  it('ignores roles of other modules', () => {
    expect(permits([{ module: 'sales', role: 'admin' }], 'read')).toBe(false)
  })
})
