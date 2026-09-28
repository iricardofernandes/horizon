import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DAY_MS, expiryOf, isAttachable, permits, recordTypes, retentionDaysOf } from './records'

describe('record types', () => {
  it('declares retention for every attachable record type', () => {
    const types = recordTypes()
    expect(types.map((type) => `${type.module}/${type.recordType}`)).toEqual([
      'parties/party',
      'procurement/purchase-order',
      'financial/receivable',
      'financial/payable',
      'sales/service-order',
      'crm/opportunity',
    ])
    expect(types.find((type) => type.recordType === 'party')?.retentionDays).toBeNull()
  })

  it('knows only the record types a module takes', () => {
    expect(isAttachable('financial', 'payable')).toBe(true)
    expect(isAttachable('financial', 'party')).toBe(false)
    expect(isAttachable('ledger', 'entry')).toBe(false)
    expect(() => retentionDaysOf('financial', 'party')).toThrow(/No retention/)
  })

  it('counts retention from availability, and never ends a party file', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    const record = { module: 'crm' as const, recordType: 'opportunity', recordId: randomUUID() }
    expect(expiryOf(record, at)?.getTime()).toBe(at.getTime() + 730 * DAY_MS)
    expect(expiryOf({ ...record, module: 'parties', recordType: 'party' }, at)).toBeNull()
  })
})

describe('permissions', () => {
  it('reads and writes with the owning module role only', () => {
    const editor = [{ module: 'parties', role: 'editor' }]
    expect(permits(editor, 'parties', 'write')).toBe(true)
    expect(permits(editor, 'financial', 'read')).toBe(false)
    const viewer = [{ module: 'financial', role: 'viewer' }]
    expect(permits(viewer, 'financial', 'read')).toBe(true)
    expect(permits(viewer, 'financial', 'write')).toBe(false)
  })

  it('gives an approver and a fiscal reader what their modules give them', () => {
    expect(permits([{ module: 'procurement', role: 'approver' }], 'procurement', 'read')).toBe(true)
    expect(permits([{ module: 'procurement', role: 'approver' }], 'procurement', 'write')).toBe(
      false,
    )
    expect(permits([{ module: 'parties', role: 'fiscal-reader' }], 'parties', 'read')).toBe(false)
  })
})
