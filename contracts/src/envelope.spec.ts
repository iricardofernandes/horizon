import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { eventEnvelopeSchema, eventTypeSchema } from './envelope'
import { defineEvent } from './events/define'

const validEnvelope = {
  eventId: '018f3c1e-7b4a-7000-8000-000000000001',
  eventType: 'identity.tenant.created',
  eventVersion: 1,
  occurredAt: '2026-09-07T22:00:00.000Z',
  tenantId: '018f3c1e-7b4a-7000-8000-000000000002',
  traceId: '8d90dd90c8eff85a1118f8bc18f36f0e',
  payload: {},
}

describe('event envelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(eventEnvelopeSchema.safeParse(validEnvelope).success).toBe(true)
  })

  it('rejects a trace id that is not 32 hex characters', () => {
    // A malformed trace id silently breaks the link between an event and its trace,
    // which is the whole reason it is in the envelope (ADR 0033).
    const result = eventEnvelopeSchema.safeParse({ ...validEnvelope, traceId: 'not-a-trace' })
    expect(result.success).toBe(false)
  })

  it('rejects an uppercase trace id', () => {
    const result = eventEnvelopeSchema.safeParse({
      ...validEnvelope,
      traceId: '8D90DD90C8EFF85A1118F8BC18F36F0E',
    })
    expect(result.success).toBe(false)
  })

  it('requires a tenant id', () => {
    const { tenantId: _omitted, ...withoutTenant } = validEnvelope
    // A consumer must never have to infer tenancy from payload contents (ADR 0017).
    expect(eventEnvelopeSchema.safeParse(withoutTenant).success).toBe(false)
  })

  it('rejects a zero or negative event version', () => {
    expect(eventEnvelopeSchema.safeParse({ ...validEnvelope, eventVersion: 0 }).success).toBe(false)
  })
})

describe('event type naming', () => {
  it.each([
    'identity.tenant.created',
    'sales.order.confirmed',
    'inventory.stock.reservation-rejected',
  ])('accepts %s', (type) => {
    expect(eventTypeSchema.safeParse(type).success).toBe(true)
  })

  it.each([
    ['Sales.Order.Confirmed', 'uppercase'],
    ['sales.order', 'only two segments'],
    ['sales.order.confirmed.extra', 'four segments'],
    ['sales_order_confirmed', 'underscores'],
  ])('rejects %s (%s)', (type) => {
    expect(eventTypeSchema.safeParse(type).success).toBe(false)
  })

  it('refuses to define an event whose name breaks the rule', () => {
    // Enforced when the event is defined rather than when one is published, so the
    // mistake cannot reach a consumer.
    expect(() =>
      defineEvent({
        type: 'SalesOrderConfirmed',
        version: 1,
        description: 'x',
        payload: z.object({}),
      }),
    ).toThrow(/invalid event type/)
  })
})
