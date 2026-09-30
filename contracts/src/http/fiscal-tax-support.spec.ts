import { describe, expect, it } from 'vitest'

import {
  fiscalTaxSupportAnswerSchema,
  fiscalTaxSupportMatrixSchema,
  fiscalTaxSupportQuerySchema,
} from './fiscal-tax-support'

const row = {
  id: 'phase85-f5-sp-rj-non-contributor-lucro-presumido',
  model: '55',
  environment: 'simulation',
  from: '2026-01-01',
  until: '2027-01-01',
  taxes: ['IPI', 'ICMS', 'ICMS_UF_DEST', 'FCP_UF_DEST', 'PIS', 'COFINS'],
  dimensions: {
    classification: { kind: 'ncm', code: '85094010' },
    originState: '35',
    destinationState: '33',
    recipientTaxpayer: false,
    issuerRegime: 'lucro-presumido',
    facts: { ipiTaxpayer: 'true' },
  },
  evidence: {
    kind: 'approved-fixture',
    reference: 'fiscal/fixtures/phase85/phase85-f5-sp-rj-non-contributor-lucro-presumido.json',
    digest: 'a'.repeat(64),
  },
}

describe('the tax support matrix', () => {
  it('holds rows backed by evidence, and is unsupported by default', () => {
    expect(
      fiscalTaxSupportMatrixSchema.parse({
        schemaVersion: 1,
        defaultStatus: 'unsupported',
        rows: [row],
      }).rows,
    ).toHaveLength(1)
    expect(
      fiscalTaxSupportMatrixSchema.safeParse({
        schemaVersion: 1,
        defaultStatus: 'unsupported',
        rows: [{ ...row, evidence: { ...row.evidence, kind: 'rules-exist' } }],
      }).success,
    ).toBe(false)
  })

  it('answers a scenario as supported with its rows, or unsupported naming the missing dimension', () => {
    expect(fiscalTaxSupportAnswerSchema.parse({ status: 'supported', rows: [row] }).status).toBe(
      'supported',
    )
    expect(
      fiscalTaxSupportAnswerSchema.parse({
        status: 'unsupported',
        missingDimension: 'destinationState',
      }),
    ).toEqual({ status: 'unsupported', missingDimension: 'destinationState' })
    expect(
      fiscalTaxSupportQuerySchema.safeParse({
        model: '55',
        date: '2026-10-15',
        tax: 'ICMS',
        classification: { kind: 'ncm', code: '85094010' },
      }).success,
    ).toBe(true)
  })
})
