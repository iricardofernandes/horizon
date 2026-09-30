import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FiscalTaxSupportMatrix } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'
import { answer, buildSupportMatrix, supportEvidence } from './tax-support'
import { taxSupportResponse } from './tax-support-api'

const REPOSITORY = join(__dirname, '..', '..')

const matrix: FiscalTaxSupportMatrix = {
  schemaVersion: 1,
  defaultStatus: 'unsupported',
  rows: [
    {
      id: 'f5',
      model: '55',
      environment: 'simulation',
      from: '2026-01-01',
      until: '2027-01-01',
      taxes: ['ICMS', 'ICMS_UF_DEST'],
      dimensions: {
        classification: { kind: 'ncm', code: '85094010' },
        originState: '35',
        destinationState: '33',
        recipientTaxpayer: false,
      },
      evidence: { kind: 'approved-fixture', reference: 'f5.json', digest: 'a'.repeat(64) },
    },
  ],
}
const query = {
  model: '55' as const,
  date: '2026-10-15',
  tax: 'ICMS_UF_DEST',
  classification: { kind: 'ncm' as const, code: '85094010' },
  originState: '35',
  destinationState: '33',
  recipientTaxpayer: false,
}

describe('the support matrix', () => {
  it('supports a scenario its evidence covers', () => {
    expect(answer(matrix, query)).toMatchObject({ status: 'supported', rows: [{ id: 'f5' }] })
  })

  it('names the first dimension no row covers', () => {
    expect(answer(matrix, { ...query, destinationState: '31' })).toEqual({
      status: 'unsupported',
      missingDimension: 'destinationState',
    })
    expect(answer(matrix, { ...query, date: '2027-01-01' })).toEqual({
      status: 'unsupported',
      missingDimension: 'date',
    })
    expect(answer(matrix, { ...query, tax: 'ICMS_ST' })).toEqual({
      status: 'unsupported',
      missingDimension: 'tax',
    })
    expect(answer(matrix, { ...query, recipientTaxpayer: true })).toEqual({
      status: 'unsupported',
      missingDimension: 'recipientTaxpayer',
    })
    const withFacts = {
      ...matrix,
      rows: matrix.rows.map((row) => ({
        ...row,
        dimensions: { ...row.dimensions, facts: { ipiTaxpayer: 'true' } },
      })),
    }
    expect(answer(withFacts, query)).toEqual({ status: 'unsupported', missingDimension: 'facts' })
    expect(answer(withFacts, { ...query, facts: { ipiTaxpayer: 'true' } }).status).toBe('supported')
  })

  it.skipIf(!existsSync(join(REPOSITORY, 'docs', 'drills')))(
    'lists a legacy scenario only once its fixture is approved',
    async () => {
      const evidence = await supportEvidence(REPOSITORY)
      const unapproved = evidence.fixtures.map(({ reference, fixture }) => ({
        reference,
        fixture: { ...fixture, approval: null },
      }))
      const rows = buildSupportMatrix({ oracleReports: [], fixtures: unapproved }).rows
      expect(rows).toEqual([])
    },
  )

  it.skipIf(!existsSync(join(REPOSITORY, 'docs', 'drills')))(
    'is committed exactly as the evidence generates it',
    async () => {
      const committed = JSON.parse(
        await readFile(join(REPOSITORY, 'fiscal', 'support-matrix.json'), 'utf8'),
      )
      expect(buildSupportMatrix(await supportEvidence(REPOSITORY))).toEqual(committed)
    },
  )
})

describe('GET /support', () => {
  it('answers the matrix, a scenario, or a bad request', () => {
    expect(taxSupportResponse(new URLSearchParams(), matrix)).toEqual({ status: 200, body: matrix })
    const params = new URLSearchParams({
      model: '55',
      date: '2026-10-15',
      tax: 'FCP_UF_DEST',
      ncm: '85094010',
      originState: '35',
      destinationState: '33',
      recipientTaxpayer: 'false',
    })
    expect(taxSupportResponse(params, matrix)).toEqual({
      status: 200,
      body: { status: 'unsupported', missingDimension: 'tax' },
    })
    expect(
      taxSupportResponse(new URLSearchParams({ model: '55', ncm: '1', service: '2' }), matrix),
    ).toMatchObject({ status: 400 })
    expect(
      taxSupportResponse(
        new URLSearchParams({ ...Object.fromEntries(params), recipientTaxpayer: 'maybe' }),
        matrix,
      ),
    ).toMatchObject({ status: 400 })
  })
})
