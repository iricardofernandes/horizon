import { describe, expect, it } from 'vitest'
import { calculateFiscal, type ResolvedRuleSet } from './calculation'

const lineId = '018f5d4e-7b4a-7abc-8def-1234567890ab'

const input = {
  schemaVersion: 1,
  tenantId: '018f5d4e-0000-7000-8000-000000000001',
  issuerEstablishmentId: '018f5d4e-0000-7000-8000-000000000002',
  model: '55',
  environment: 'simulation',
  operation: 'illustrative-internal-sale',
  purpose: 'normal',
  issuer: { regime: 'illustrative-normal', stateCode: '35', municipalityCode: '3550308' },
  recipient: {
    regime: 'illustrative-normal',
    stateCode: '35',
    municipalityCode: '3550308',
    taxpayer: true,
  },
  origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
  destination: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
  issueDate: '2026-09-21',
  currency: 'BRL',
  lines: [
    {
      id: lineId,
      itemId: '018f5d4e-0000-7000-8000-000000000003',
      quantity: '2.5',
      unitPrice: '10.05',
      discount: { amount: '13', currency: 'BRL' },
      charges: { amount: '1', currency: 'BRL' },
      classifications: { ncm: '12345678' },
      taxFacts: {},
    },
  ],
} as const

function rules(): ResolvedRuleSet {
  return {
    schemaVersion: 1,
    currencyMinorUnitScale: 2,
    explanationTemplateVersion: 'fiscal-explanation-v1',
    lines: {
      [lineId]: [
        {
          group: 'legacy',
          code: 'ILLUSTRATIVE_TAX',
          rate: { numerator: '1', denominator: '10' },
          formula: 'LINE_NET_TIMES_RATE',
          rule: { id: '018f5d4e-0000-7000-8000-000000000004', version: 1 },
          source: {
            packageId: '018f5d4e-0000-7000-8000-000000000005',
            digest: 'a'.repeat(64),
            uri: 'https://example.invalid/illustrative-source',
            section: 'fixture-only',
            approved: true,
          },
        },
      ],
    },
  }
}

describe('pure Fiscal calculation', () => {
  it('calculates and explains a line with exact arithmetic', () => {
    const outcome = calculateFiscal(input, rules())
    expect(outcome.supported).toBe(true)
    if (!outcome.supported) return
    expect(outcome.lines[0]).toMatchObject({
      gross: { amount: '2513', currency: 'BRL' },
      net: { amount: '2501', currency: 'BRL' },
      components: {
        legacy: [
          {
            amount: { amount: '250', currency: 'BRL' },
            unrounded: { numerator: '2501', denominator: '10', currency: 'BRL' },
          },
        ],
      },
    })
    expect(outcome.explanation.text).toContain('ILLUSTRATIVE_TAX')
  })

  it('is byte-for-byte deterministic', () => {
    expect(calculateFiscal(input, rules())).toEqual(calculateFiscal(input, rules()))
  })

  it('does not infer a zero rate when no rule matches', () => {
    const missing = rules()
    missing.lines = {}
    expect(calculateFiscal(input, missing)).toMatchObject({
      supported: false,
      code: 'UNSUPPORTED_RULE',
      missingDimension: lineId,
    })
  })

  it('rejects a discount that would create an implicit negative operation', () => {
    const excessiveDiscount = {
      ...input,
      lines: [{ ...input.lines[0], discount: { amount: '9999', currency: 'BRL' } }],
    }
    expect(calculateFiscal(excessiveDiscount, rules())).toMatchObject({
      supported: false,
      code: 'INVALID_FISCAL_INPUT',
      missingDimension: lineId,
    })
  })

  it('rejects duplicate immutable line identifiers', () => {
    const duplicateLines = { ...input, lines: [input.lines[0], { ...input.lines[0] }] }
    expect(calculateFiscal(duplicateLines, rules())).toMatchObject({
      supported: false,
      code: 'INVALID_FISCAL_INPUT',
      missingDimension: lineId,
    })
  })

  it('rejects unapproved sources and ambiguous components', () => {
    const base = rules()
    const selected = base.lines[lineId]?.[0]
    if (!selected) throw new Error('fixture has no rule')
    const unapproved: ResolvedRuleSet = {
      ...base,
      lines: {
        ...base.lines,
        [lineId]: [{ ...selected, source: { ...selected.source, approved: false } }],
      },
    }
    expect(calculateFiscal(input, unapproved)).toMatchObject({
      supported: false,
      code: 'SOURCE_NOT_APPROVED',
    })

    const ambiguous: ResolvedRuleSet = {
      ...base,
      lines: {
        ...base.lines,
        [lineId]: [selected, { ...selected, rule: { ...selected.rule, version: 2 } }],
      },
    }
    expect(calculateFiscal(input, ambiguous)).toMatchObject({
      supported: false,
      code: 'AMBIGUOUS_RULE',
    })
  })

  it('allocates document-rounding residuals by stable line id and reconciles totals', () => {
    const lineIds = [
      '018f5d4e-0000-7000-8000-000000000011',
      '018f5d4e-0000-7000-8000-000000000012',
      '018f5d4e-0000-7000-8000-000000000013',
    ]
    const baseLine = input.lines[0]
    const baseRule = rules().lines[lineId]?.[0]
    if (!baseLine || !baseRule) throw new Error('fixture is incomplete')
    const documentInput = {
      ...input,
      lines: lineIds.map((id) => ({
        ...baseLine,
        id,
        quantity: '1',
        unitPrice: '0.01',
        discount: { amount: '0', currency: 'BRL' },
        charges: { amount: '0', currency: 'BRL' },
      })),
    }
    const documentRules: ResolvedRuleSet = {
      ...rules(),
      lines: Object.fromEntries(
        lineIds.map((id) => [
          id,
          [
            {
              ...baseRule,
              rate: { numerator: '1', denominator: '2' },
              formula: 'DOCUMENT_NET_TIMES_RATE' as const,
            },
          ],
        ]),
      ),
    }
    const outcome = calculateFiscal(documentInput, documentRules)
    expect(outcome.supported).toBe(true)
    if (!outcome.supported) return
    expect(outcome.lines.map((line) => line.components.legacy[0]?.amount.amount)).toEqual([
      '1',
      '1',
      '0',
    ])
    expect(outcome.totals.legacyTax.amount).toBe('2')
    expect(outcome.reconciliation.legacyComponentSum).toEqual(outcome.totals.legacyTax)
    expect(
      calculateFiscal(
        { ...documentInput, lines: [...documentInput.lines].reverse() },
        documentRules,
      ),
    ).toEqual(outcome)
  })
})
