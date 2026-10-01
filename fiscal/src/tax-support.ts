import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FISCAL_TAX_SUPPORT_DIMENSIONS,
  type FiscalCalculationInput,
  type FiscalCalculationResult,
  type FiscalTaxSupportAnswer,
  type FiscalTaxSupportMatrix,
  type FiscalTaxSupportQuery,
  type FiscalTaxSupportRow,
  fiscalTaxSupportMatrixSchema,
} from '@horizon/contracts'
import { approvedScenarioRows } from './approved-scenarios'
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
  /** The scenarios Phases 41 to 47 approved, read from their reviewed sources (Phase 87). */
  approvedScenarios?: readonly FiscalTaxSupportRow[]
}): FiscalTaxSupportMatrix {
  const rows: FiscalTaxSupportRow[] = [...(evidence.approvedScenarios ?? [])]
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
    // The taxes the fixture's own result carries, so a row says exactly what was approved.
    const calculated = new Set(
      fixture.expectedResult.lines.flatMap((line) =>
        [...line.components.legacy, ...line.components.ibsCbs].map((component) => component.code),
      ),
    )
    rows.push({
      id: fixture.fixtureId,
      model: covers.model,
      environment: 'simulation',
      from: covers.from,
      until: covers.until,
      taxes: [...calculated].sort(),
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
  operation: (row, query) =>
    row.dimensions.operation === undefined || row.dimensions.operation === query.operation,
  purpose: (row, query) =>
    row.dimensions.purpose === undefined || row.dimensions.purpose === (query.purpose ?? 'normal'),
  classification: (row, query) =>
    row.dimensions.classification === undefined ||
    (row.dimensions.classification.kind === query.classification.kind &&
      row.dimensions.classification.code === query.classification.code),
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

type Refusal = { supported: false; detail: string; missingDimension: string }

/**
 * Whether a calculation may be locked (Phase 87, ADR 0072): on every line, each component
 * calculated is covered by a row that admits the line, and every such row's taxes were all
 * calculated. A line with a component no evidence covers, or evidence of a tax the
 * calculation did not give, is refused, naming what is missing.
 */
export function scenarioSupport(
  matrix: FiscalTaxSupportMatrix,
  input: FiscalCalculationInput,
  result: FiscalCalculationResult,
): { supported: true } | Refusal {
  for (const line of result.lines) {
    const source = input.lines.find((candidate) => candidate.id === line.lineId)
    if (!source) continue
    const computed = new Set(
      [...line.components.legacy, ...line.components.ibsCbs].map((component) => component.code),
    )
    if (computed.size === 0) continue
    const classifications = (
      [
        ['ncm', source.classifications.ncm],
        ['service', source.classifications.service],
        ['class_trib', source.classifications.classTrib],
      ] as const
    ).flatMap(([kind, code]) => (code ? [{ kind, code }] : []))
    const query = (tax: string, classification = classifications[0]): FiscalTaxSupportQuery => ({
      model: input.model,
      date: input.model === 'nfse' ? (input.competenceDate ?? input.issueDate) : input.issueDate,
      tax,
      operation: input.operation,
      purpose: input.purpose,
      classification: classification ?? { kind: 'ncm', code: '-' },
      originState: input.origin.stateCode,
      destinationState: input.destination.stateCode,
      recipientTaxpayer: input.recipient.taxpayer,
      issuerRegime: input.issuer.regime,
      ...(input.issuer.incomeTaxRegime ? { incomeTaxRegime: input.issuer.incomeTaxRegime } : {}),
      issuerMunicipality: input.issuer.municipalityCode,
      ...(source.classifications.origin ? { origin: source.classifications.origin } : {}),
      facts: source.taxFacts,
    })
    const scenario = query('')
    const admitted = matrix.rows.filter(
      (row) =>
        row.environment === input.environment &&
        FISCAL_TAX_SUPPORT_DIMENSIONS.every(
          (dimension) =>
            dimension === 'tax' ||
            (dimension === 'classification'
              ? row.dimensions.classification === undefined ||
                classifications.some((classification) =>
                  admits.classification(row, { ...scenario, classification }),
                )
              : admits[dimension](row, scenario)),
        ),
    )
    const covered = new Set(admitted.flatMap((row) => row.taxes))
    const uncovered = [...computed].sort().find((code) => !covered.has(code))
    if (uncovered) {
      const found = answer(
        { ...matrix, rows: matrix.rows.filter((row) => row.environment === input.environment) },
        query(uncovered),
      )
      return {
        supported: false,
        detail: `No approved evidence covers ${uncovered} in this scenario`,
        missingDimension:
          found.status === 'unsupported'
            ? `${found.missingDimension}:${uncovered}`
            : `tax:${uncovered}`,
      }
    }
    for (const row of admitted) {
      const absent = row.taxes.find((tax) => !computed.has(tax))
      if (absent)
        return {
          supported: false,
          detail: `The approved scenario ${row.id} carries ${absent}, which this calculation did not give`,
          missingDimension: `component:${absent}`,
        }
    }
  }
  return { supported: true }
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
  const evidenceOf = async (phase: string) => {
    const reference = `docs/fiscal-phase${phase}-evidence.md`
    return { reference, digest: sha256(await readFile(join(repository, reference))) }
  }
  const approvedScenarios = approvedScenarioRows({
    '41': await evidenceOf('41'),
    '43': await evidenceOf('43'),
    '45': await evidenceOf('45'),
    '46': await evidenceOf('46'),
    '47': await evidenceOf('47'),
  })
  return {
    approvedScenarios,
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
