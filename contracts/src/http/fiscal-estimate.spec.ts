import { describe, expect, it } from 'vitest'

import { fiscalCalculationLocked } from '../events/fiscal'
import { fiscalTaxEstimateRequestSchema, fiscalTaxEstimateSchema } from './fiscal-estimate'

const id = '018f5d4e-1000-7000-8000-000000000087'
const digest = 'a'.repeat(64)
const brl = (amount: string) => ({ amount, currency: 'BRL' })

describe('tax estimates', () => {
  it('asks the caller for a supplier regime on a purchase, never on a sale', () => {
    const line = { itemId: id, quantity: '2', unitPrice: brl('18990') }
    expect(
      fiscalTaxEstimateRequestSchema.safeParse({
        direction: 'sale',
        establishmentId: id,
        customerPartyId: id,
        issueDate: '2026-10-15',
        lines: [line],
      }).success,
    ).toBe(true)
    expect(
      fiscalTaxEstimateRequestSchema.safeParse({
        direction: 'purchase',
        establishmentId: id,
        supplierPartyId: id,
        issueDate: '2026-10-15',
        lines: [line],
      }).success,
    ).toBe(false)
  })

  it('is supported with components, totals and digests, or names what is missing', () => {
    expect(
      fiscalTaxEstimateSchema.parse({
        schemaVersion: 1,
        supported: true,
        estimatedAt: '2026-10-01T12:00:00Z',
        components: [{ group: 'legacy', code: 'IPI', amount: brl('2469'), outcome: 'levied' }],
        totals: {
          net: brl('37980'),
          tax: brl('2469'),
          chargedOnTop: brl('2469'),
          gross: brl('40449'),
        },
        inputDigest: digest,
        rulesDigest: digest,
        resultDigest: digest,
      }).supported,
    ).toBe(true)
    expect(
      fiscalTaxEstimateSchema.parse({
        schemaVersion: 1,
        supported: false,
        estimatedAt: '2026-10-01T12:00:00Z',
        code: 'UNSUPPORTED_RULE',
        detail: 'No effective active rule matches this fiscal line',
      }).supported,
    ).toBe(false)
  })
})

describe('fiscal.calculation.locked', () => {
  it('carries signed components and digests, never rules', () => {
    const payload = {
      documentId: id,
      originModule: 'sales',
      originId: id,
      purpose: 'return',
      model: '55',
      environment: 'simulation',
      issueDate: '2026-10-15',
      currency: 'BRL',
      components: [{ group: 'legacy', code: 'ICMS', amount: '-6836', outcome: 'levied' }],
      totals: { net: '-37980', legacyTax: '-6836', ibsCbsTax: '0' },
      inputDigest: digest,
      rulesDigest: digest,
      resultDigest: digest,
    }
    expect(fiscalCalculationLocked.payload.parse(payload).components).toHaveLength(1)
    expect(fiscalCalculationLocked.payload.safeParse({ ...payload, rules: [] }).success).toBe(false)
  })
})
