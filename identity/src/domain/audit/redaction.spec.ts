import { describe, expect, it } from 'vitest'
import { redact } from './redaction'

describe('audit secret redaction', () => {
  it('redacts sensitive names case-insensitively and returns sorted paths without mutating input', () => {
    const input = {
      PASSWORD: 'hidden',
      nested: { authorization: 'Bearer hidden', name: 'Visible' },
      count: 3,
      missing: null,
    }
    expect(redact(input)).toEqual({
      data: { nested: { name: 'Visible' }, count: 3, missing: null },
      fields: ['PASSWORD', 'nested.authorization'],
    })
    expect(input.nested.authorization).toBe('Bearer hidden')
    expect(redact(null)).toEqual({ data: null, fields: [] })
  })
  it('redacts secrets nested inside arrays and records each indexed path', () => {
    const occurredAt = new Date('2026-09-10T12:00:00Z')
    const input = {
      changes: [
        { token: 'hidden', name: 'first' },
        [{ password_hash: 'hidden', active: true }],
        null,
      ],
      occurredAt,
    }
    expect(redact(input)).toEqual({
      data: { changes: [{ name: 'first' }, [{ active: true }], null], occurredAt },
      fields: ['changes.0.token', 'changes.1.0.password_hash'],
    })
    expect(input.changes[0]).toMatchObject({ token: 'hidden' })
  })
  it('walks null-prototype records and preserves values that are not plain records', () => {
    const record = Object.assign(Object.create(null), { secret: 'hidden', visible: true })
    const marker = new Map([['name', 'value']])
    expect(redact({ record, marker })).toEqual({
      data: { record: { visible: true }, marker },
      fields: ['record.secret'],
    })
  })
})
