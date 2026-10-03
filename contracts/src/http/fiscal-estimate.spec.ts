import { describe, expect, it } from 'vitest'

import { fiscalCalculationLocked } from '../events/fiscal'
import {
  estimateRequestMatches,
  fiscalTaxEstimateRecordSchema,
  fiscalTaxEstimateReferenceSchema,
  fiscalTaxEstimateRequestSchema,
  fiscalTaxEstimateSchema,
} from './fiscal-estimate'

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

describe('an estimate kept by reference (Phase 91)', () => {
  const item = '018f5d4e-1000-7000-8000-000000000001'
  const other = '018f5d4e-1000-7000-8000-000000000002'
  const request = fiscalTaxEstimateRequestSchema.parse({
    direction: 'sale',
    establishmentId: id,
    customerPartyId: id,
    issueDate: '2026-10-15',
    lines: [
      { itemId: item, quantity: '2', unitPrice: brl('18990') },
      { itemId: other, quantity: '1.5', unitPrice: brl('1000'), discount: brl('100') },
    ],
  })
  const document = {
    direction: 'sale' as const,
    partyId: id,
    lines: [
      { itemId: other, quantity: '1.500', unitPrice: brl('1000'), discount: brl('100') },
      { itemId: item, quantity: '2.0', unitPrice: brl('18990') },
    ],
  }

  it('takes only a digest from the web, never the estimate itself', () => {
    expect(fiscalTaxEstimateReferenceSchema.safeParse({ resultDigest: digest }).success).toBe(true)
    expect(
      fiscalTaxEstimateReferenceSchema.safeParse({ resultDigest: digest, components: [] }).success,
    ).toBe(false)
  })

  it('reads back the request with a supported estimate only', () => {
    const estimate = {
      schemaVersion: 1,
      supported: true,
      estimatedAt: '2026-10-01T12:00:00Z',
      components: [],
      totals: { net: brl('1'), tax: brl('0'), chargedOnTop: brl('0'), gross: brl('1') },
      inputDigest: digest,
      rulesDigest: digest,
      resultDigest: digest,
    }
    expect(fiscalTaxEstimateRecordSchema.safeParse({ request, estimate }).success).toBe(true)
    expect(
      fiscalTaxEstimateRecordSchema.safeParse({
        request,
        estimate: { ...estimate, supported: false },
      }).success,
    ).toBe(false)
  })

  it('matches the same lines in any order, whatever zeros a quantity carries', () => {
    expect(estimateRequestMatches(request, document)).toBe(true)
    const [first, second] = document.lines
    if (!first || !second) throw new Error('two lines')
    expect(
      estimateRequestMatches(request, {
        ...document,
        lines: [first, { ...second, discount: brl('0') }],
      }),
    ).toBe(true)
  })

  it('refuses another party, direction, price, quantity, discount or line', () => {
    const [first, second] = document.lines
    if (!first || !second) throw new Error('two lines')
    for (const changed of [
      { ...document, partyId: item },
      { ...document, direction: 'purchase' as const },
      { ...document, lines: [first, { ...second, unitPrice: brl('18991') }] },
      { ...document, lines: [first, { ...second, quantity: '3' }] },
      { ...document, lines: [{ ...first, discount: undefined }, second] },
      { ...document, lines: [first] },
      { ...document, lines: [first, second, second] },
    ])
      expect(estimateRequestMatches(request, changed)).toBe(false)
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
