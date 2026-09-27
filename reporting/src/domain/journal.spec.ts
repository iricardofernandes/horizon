import { describe, expect, it } from 'vitest'
import { journalEntryOf, redact, sourceOf } from './journal'

const event = {
  eventId: '0196a1b2-0000-7000-8000-000000000001',
  tenantId: '0196a1b2-0000-7000-8000-0000000000aa',
  eventType: 'procurement.receipt.recorded',
  eventVersion: 1,
  occurredAt: '2026-09-27T12:00:00.123Z',
  traceId: '0'.repeat(32),
  payload: { orderId: 'x', supplierId: 'y', supplierName: 'Maria Silva' },
}

describe('the journal', () => {
  it('knows the module of an event type, and journals none of parties or identity', () => {
    expect(sourceOf('sales.order.placed')).toBe('sales')
    expect(sourceOf('crm.opportunity.won')).toBe('crm')
    expect(sourceOf('parties.party.registered')).toBeNull()
    expect(sourceOf('identity.user.registered')).toBeNull()
    expect(sourceOf('')).toBeNull()
  })

  it('removes a field that may name a person before the row exists', () => {
    const entry = journalEntryOf(event, 'live')
    expect(entry?.payload).toEqual({ orderId: 'x', supplierId: 'y' })
    expect(entry).toMatchObject({ source: 'procurement', arrival: 'live' })
    expect(entry?.occurredAt.toISOString()).toBe('2026-09-27T12:00:00.123Z')
    expect(redact('sales', { supplierName: 'kept' })).toEqual({ supplierName: 'kept' })
  })

  it('refuses nothing it does not journal, and a payload that is not an object', () => {
    expect(journalEntryOf({ ...event, eventType: 'parties.party.erased' }, 'replay')).toBeNull()
    expect(() => journalEntryOf({ ...event, payload: [1] }, 'live')).toThrow(/object/)
  })
})
