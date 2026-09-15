import { describe, expect, it } from 'vitest'
import { Redactor } from './redactor.js'

describe('Redactor', () => {
  it('hashes tenant identifiers consistently and masks nested configured PII', () => {
    const redactor = new Redactor('0123456789abcdef', new Set(['email', 'phone']))
    const result = redactor.apply({
      tenantId: 'tenant-1',
      actor: { email: 'person@example.test', phone: null },
      rows: [{ tenant_id: 'tenant-1' }],
      raw: 'failed for fallback@example.test and CPF 123.456.789-00',
    })
    expect(result).toEqual({
      tenantId: expect.stringMatching(/^tenant_[a-f0-9]{16}$/),
      actor: { email: '[REDACTED]', phone: null },
      rows: [{ tenant_id: expect.stringMatching(/^tenant_[a-f0-9]{16}$/) }],
      raw: 'failed for [REDACTED_EMAIL] and CPF [REDACTED_CPF]',
    })
    expect(
      (result as { tenantId: string; rows: Array<{ tenant_id: string }> }).rows[0]?.tenant_id,
    ).toBe((result as { tenantId: string }).tenantId)
  })
})
