import type { FiscalCalculationInput } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'
import { resolveTaxRules, type TaxRule } from './rules'

const tenantId = '018f5d4e-1000-7000-8000-000000000001'
const otherTenantId = '018f5d4e-1000-7000-8000-000000000002'
const lineId = '018f5d4e-1000-7000-8000-000000000003'
const itemId = '018f5d4e-1000-7000-8000-000000000004'

const input: FiscalCalculationInput = {
  schemaVersion: 1,
  tenantId,
  issuerEstablishmentId: '018f5d4e-1000-7000-8000-000000000005',
  model: '55',
  environment: 'simulation',
  operation: 'illustrative-sale',
  purpose: 'normal',
  issuer: { regime: 'normal', stateCode: '35', municipalityCode: '3550308' },
  recipient: {
    regime: 'normal',
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
      itemId,
      quantity: '1',
      unitPrice: '10',
      discount: { amount: '0', currency: 'BRL' },
      charges: { amount: '0', currency: 'BRL' },
      classifications: { ncm: '12345678' },
      taxFacts: {},
    },
  ],
}

function rule(overrides: Partial<TaxRule> = {}): TaxRule {
  return {
    tenantId,
    group: 'legacy',
    code: 'ILLUSTRATIVE_TAX',
    precedence: 'default',
    priority: 0,
    dateBasis: 'issue_date',
    effectiveFrom: '2026-09-01',
    effectiveTo: '2026-10-01',
    active: true,
    scope: { model: '55', environment: 'simulation' },
    rate: { numerator: '1', denominator: '10' },
    formula: 'LINE_NET_TIMES_RATE',
    rule: { id: '018f5d4e-1000-7000-8000-000000000006', version: 1 },
    source: {
      packageId: '018f5d4e-1000-7000-8000-000000000007',
      digest: 'a'.repeat(64),
      uri: 'https://example.invalid/illustrative',
      section: 'fixture-only',
      approved: true,
    },
    ...overrides,
  }
}

describe('temporal tax rule resolution', () => {
  it('uses half-open effective intervals on their first and last valid days', () => {
    expect(resolveTaxRules({ ...input, issueDate: '2026-09-01' }, [rule()], 2).supported).toBe(true)
    expect(resolveTaxRules({ ...input, issueDate: '2026-09-30' }, [rule()], 2).supported).toBe(true)
    expect(resolveTaxRules({ ...input, issueDate: '2026-10-01' }, [rule()], 2)).toMatchObject({
      supported: false,
      code: 'UNSUPPORTED_RULE',
    })
  })

  it('selects operation over establishment, item, party and default precedence', () => {
    const candidates = [
      rule(),
      rule({
        precedence: 'item',
        priority: 1,
        scope: { ...rule().scope, subject: { kind: 'item', id: itemId } },
        rule: { id: '018f5d4e-1000-7000-8000-000000000008', version: 1 },
      }),
      rule({
        precedence: 'operation',
        scope: { ...rule().scope, operation: input.operation },
        rule: { id: '018f5d4e-1000-7000-8000-000000000009', version: 1 },
      }),
    ]
    const outcome = resolveTaxRules(input, candidates, 2)
    expect(outcome).toMatchObject({
      supported: true,
      trace: [{ selectedRuleId: '018f5d4e-1000-7000-8000-000000000009' }],
    })
  })

  it('rejects equal-precedence and equal-priority ambiguity at runtime', () => {
    expect(
      resolveTaxRules(
        input,
        [rule(), rule({ rule: { id: '018f5d4e-1000-7000-8000-000000000010', version: 2 } })],
        2,
      ),
    ).toMatchObject({ supported: false, code: 'AMBIGUOUS_RULE' })
  })

  it('does not select inactive, cross-tenant or unapproved rules', () => {
    expect(
      resolveTaxRules(
        input,
        [
          rule({ tenantId: otherTenantId }),
          rule({ active: false }),
          rule({ source: { ...rule().source, approved: false } }),
        ],
        2,
      ),
    ).toMatchObject({ supported: false, code: 'SOURCE_NOT_APPROVED' })
  })

  it('reports a missing required classification separately', () => {
    const line = input.lines[0]
    if (!line) throw new Error('fixture has no line')
    expect(
      resolveTaxRules(
        { ...input, lines: [{ ...line, classifications: {} }] },
        [rule({ scope: { ...rule().scope, classification: { kind: 'ncm', code: '12345678' } } })],
        2,
      ),
    ).toMatchObject({ supported: false, code: 'MISSING_CLASSIFICATION' })
  })

  it('uses competence date only when the selected component declares it', () => {
    const competenceRule = rule({
      dateBasis: 'competence_date',
      effectiveFrom: '2026-08-01',
      effectiveTo: '2026-09-01',
    })
    expect(
      resolveTaxRules({ ...input, competenceDate: '2026-08-31' }, [competenceRule], 2).supported,
    ).toBe(true)
    expect(resolveTaxRules(input, [competenceRule], 2)).toMatchObject({
      supported: false,
      code: 'UNSUPPORTED_RULE',
    })
  })
})
