import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FISCAL_TAX_SUPPORT_DIMENSIONS,
  type FiscalTaxSupportAnswer,
  type FiscalTaxSupportMatrix,
  type FiscalTaxSupportQuery,
  type FiscalTaxSupportRow,
  fiscalTaxSupportMatrixSchema,
} from '@horizon/contracts'
import type { Fixture } from './legacy-scenarios'

/**
 * The tax support matrix (Phase 85, ADR 0072), generated from evidence and never written by
 * hand: one row per IBS/CBS classification the official calculator agreed on, and one per
 * legacy-tax scenario the workspace owner approved.
 */

export type OracleReport = {
  window: { effectiveFrom: string; effectiveTo: string }
  matrix: { classTrib: string; supported: boolean }[]
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export function buildSupportMatrix(evidence: {
  oracleReports: readonly { reference: string; bytes: Buffer }[]
  fixtures: readonly { reference: string; fixture: Fixture }[]
}): FiscalTaxSupportMatrix {
  const rows: FiscalTaxSupportRow[] = []
  for (const { reference, bytes } of evidence.oracleReports) {
    const report = JSON.parse(bytes.toString('utf8')) as OracleReport
    // The corpus put model 55 documents to the calculator, so model 55 is what it proves.
    for (const entry of report.matrix.filter((row) => row.supported))
      rows.push({
        id: `oracle:${report.window.effectiveFrom}:${entry.classTrib}`,
        model: '55',
        environment: 'simulation',
        from: report.window.effectiveFrom,
        until: report.window.effectiveTo,
        taxes: ['CBS', 'IBS_MUN', 'IBS_UF'],
        // The corpus was calculated for a normal issuer; a Simples one is outside it (LC 214 art. 348 III c).
        dimensions: {
          classification: { kind: 'class_trib', code: entry.classTrib },
          issuerRegime: 'normal',
        },
        evidence: { kind: 'oracle', reference, digest: sha256(bytes) },
      })
  }
  for (const { reference, fixture } of evidence.fixtures) {
    if (!fixture.approval || !fixture.expectedResult.supported) continue
    const covers = fixture.covers
    rows.push({
      id: fixture.fixtureId,
      model: covers.model,
      environment: 'simulation',
      from: covers.from,
      until: covers.until,
      taxes: [...covers.taxes].sort(),
      dimensions: {
        classification: covers.classification,
        originState: covers.originState,
        destinationState: covers.destinationState,
        recipientTaxpayer: covers.recipientTaxpayer,
        // The regime the fixture was calculated for, stated or not: a normal issuer's scenario
        // says nothing about a Simples one.
        issuerRegime: covers.issuerRegime ?? fixture.input.issuer.regime,
        ...(fixture.input.issuer.incomeTaxRegime
          ? { incomeTaxRegime: fixture.input.issuer.incomeTaxRegime }
          : {}),
        ...(covers.issuerMunicipality ? { issuerMunicipality: covers.issuerMunicipality } : {}),
        ...(covers.origin ? { origin: covers.origin } : {}),
        ...(Object.keys(covers.facts).length > 0 ? { facts: covers.facts } : {}),
      },
      evidence: {
        kind: 'approved-fixture',
        reference,
        digest: fixture.approval.fixtureDigest,
      },
    })
  }
  return fiscalTaxSupportMatrixSchema.parse({
    schemaVersion: 1,
    defaultStatus: 'unsupported',
    rows: rows.sort((left, right) => left.id.localeCompare(right.id)),
  })
}

type Dimension = (typeof FISCAL_TAX_SUPPORT_DIMENSIONS)[number]

/** Whether a row admits the query on one dimension; a row silent on it admits anything. */
const admits: Record<
  Dimension,
  (row: FiscalTaxSupportRow, query: FiscalTaxSupportQuery) => boolean
> = {
  model: (row, query) => row.model === query.model,
  date: (row, query) => row.from <= query.date && query.date < row.until,
  tax: (row, query) => row.taxes.includes(query.tax),
  classification: (row, query) =>
    row.dimensions.classification.kind === query.classification.kind &&
    row.dimensions.classification.code === query.classification.code,
  originState: (row, query) =>
    row.dimensions.originState === undefined || row.dimensions.originState === query.originState,
  destinationState: (row, query) =>
    row.dimensions.destinationState === undefined ||
    row.dimensions.destinationState === query.destinationState,
  recipientTaxpayer: (row, query) =>
    row.dimensions.recipientTaxpayer === undefined ||
    row.dimensions.recipientTaxpayer === query.recipientTaxpayer,
  issuerRegime: (row, query) =>
    row.dimensions.issuerRegime === undefined || row.dimensions.issuerRegime === query.issuerRegime,
  incomeTaxRegime: (row, query) =>
    row.dimensions.incomeTaxRegime === undefined ||
    row.dimensions.incomeTaxRegime === query.incomeTaxRegime,
  issuerMunicipality: (row, query) =>
    row.dimensions.issuerMunicipality === undefined ||
    row.dimensions.issuerMunicipality === query.issuerMunicipality,
  origin: (row, query) =>
    row.dimensions.origin === undefined || row.dimensions.origin === query.origin,
  facts: (row, query) =>
    Object.entries(row.dimensions.facts ?? {}).every(
      ([key, value]) => query.facts?.[key] === value,
    ),
}

/**
 * Supported with the rows that cover the scenario, or unsupported naming the first dimension,
 * in a fixed order, that no remaining row covers.
 */
export function answer(
  matrix: FiscalTaxSupportMatrix,
  query: FiscalTaxSupportQuery,
): FiscalTaxSupportAnswer {
  let remaining = matrix.rows
  for (const dimension of FISCAL_TAX_SUPPORT_DIMENSIONS) {
    const kept = remaining.filter((row) => admits[dimension](row, query))
    if (kept.length === 0) return { status: 'unsupported', missingDimension: dimension }
    remaining = kept
  }
  return { status: 'supported', rows: remaining }
}

/** The evidence the matrix is generated from, with the repository-relative path of each piece. */
export async function supportEvidence(repository: string) {
  const drills = join(repository, 'docs/drills')
  const reports = (await readdir(drills))
    .filter((name) => /-phase84-oracle-2026\.json$/.test(name))
    .sort()
  // Every reviewed phase keeps its fixtures in its own directory.
  const fixtureNames = (
    await Promise.all(
      ['phase85', 'phase86'].map(async (phase) => {
        const directory = join(repository, 'fiscal/fixtures', phase)
        if (!existsSync(directory)) return []
        return (await readdir(directory))
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map((name) => `${phase}/${name}`)
      }),
    )
  ).flat()
  return {
    oracleReports: await Promise.all(
      reports.map(async (name) => ({
        reference: `docs/drills/${name}`,
        bytes: await readFile(join(drills, name)),
      })),
    ),
    fixtures: await Promise.all(
      fixtureNames.map(async (name) => ({
        reference: `fiscal/fixtures/${name}`,
        fixture: JSON.parse(
          await readFile(join(repository, 'fiscal/fixtures', name), 'utf8'),
        ) as Fixture,
      })),
    ),
  }
}
