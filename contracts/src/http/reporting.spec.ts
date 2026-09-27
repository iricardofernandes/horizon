import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { journalSealSchema, REPORTING_REPLAY_QUEUE } from './reporting'

const seal = {
  kind: 'seal',
  sealId: randomUUID(),
  source: 'sales',
  tenantId: randomUUID(),
  through: '2026-09-27T12:00:00.000Z',
  count: 42,
  sealedAt: '2026-09-27T12:02:00.000Z',
}

describe('journal seal', () => {
  it('accepts a count of a source up to an instant', () => {
    expect(journalSealSchema.parse(seal).count).toBe(42)
    expect(REPORTING_REPLAY_QUEUE).toBe('reporting.replay')
  })

  it('refuses a negative count, an unknown field and a malformed source', () => {
    expect(journalSealSchema.safeParse({ ...seal, count: -1 }).success).toBe(false)
    expect(journalSealSchema.safeParse({ ...seal, payload: {} }).success).toBe(false)
    expect(journalSealSchema.safeParse({ ...seal, source: 'Sales' }).success).toBe(false)
  })
})
