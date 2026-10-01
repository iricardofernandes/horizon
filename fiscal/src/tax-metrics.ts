import { randomUUID } from 'node:crypto'
import { metrics } from '@opentelemetry/api'
import type postgres from 'postgres'
import { z } from 'zod'

/**
 * Phase O's service levels (Phase 89): how fast a calculation answers, why it refuses, whether
 * the official calculator still agrees with the engine, and whether locks still replay. No
 * label names a tenant, document, line or item (ADR 0055).
 */
const meter = metrics.getMeter('fiscal.tax')

const calculationSeconds = meter.createHistogram('fiscal_tax_calculation_seconds', {
  description: 'Seconds to answer a tax calculation, by operation (preview, estimate, lock).',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  },
})
const answers = meter.createCounter('fiscal_tax_answers', {
  description:
    'Tax calculation answers, by operation, outcome, refusal code and missing dimension kind.',
})
const replays = meter.createCounter('fiscal_tax_lock_replays', {
  description: 'Locked calculations replayed by the sampler, by outcome.',
})

export type TaxOperation = 'preview' | 'estimate' | 'lock'

const DIMENSIONS = new Set([
  'model',
  'date',
  'tax',
  'operation',
  'purpose',
  'classification',
  'originState',
  'destinationState',
  'recipientTaxpayer',
  'issuerRegime',
  'incomeTaxRegime',
  'issuerMunicipality',
  'origin',
  'facts',
])

/**
 * The kind of a missing dimension, never its value: a line or an item is an identifier, a
 * classification names its family, a component its group.
 */
export function dimensionKind(missing: string | null | undefined): string {
  if (!missing) return 'none'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(missing)) return 'line'
  const family = /^(ncm|service|cest|class_trib):/.exec(missing)?.[1]
  if (family) return `classification-${family}`
  if (/^(legacy|ibsCbs):/.test(missing)) return 'component'
  if (DIMENSIONS.has(missing)) return missing
  if (/^[A-Z][A-Z0-9_]{0,39}$/.test(missing)) return 'tax'
  return 'other'
}

const CODES = new Set([
  'UNSUPPORTED_RULE',
  'MISSING_CLASSIFICATION',
  'AMBIGUOUS_RULE',
  'SOURCE_NOT_APPROVED',
  'INVALID_FISCAL_INPUT',
  'UNSUPPORTED_SCENARIO',
])

/** Times an answer and counts it as supported or refused, with the refusal's kind. */
export async function measured<T extends { supported: boolean }>(
  operation: TaxOperation,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now()
  const outcome = await work()
  calculationSeconds.record((performance.now() - started) / 1000, { operation })
  if (outcome.supported)
    answers.add(1, { operation, outcome: 'supported', code: 'none', dimension: 'none' })
  else {
    const refusal = outcome as unknown as { code?: string; missingDimension?: string }
    answers.add(1, {
      operation,
      outcome: 'unsupported',
      code: refusal.code && CODES.has(refusal.code) ? refusal.code : 'other',
      dimension: dimensionKind(refusal.missingDimension),
    })
  }
  return outcome
}

/**
 * Replays a sample of each served workspace's recent locks on an interval. A replay that
 * does not reproduce the stored result byte for byte is counted as failed.
 */
export function startLockReplaySampler(input: {
  tenantIds: readonly string[]
  recent: (tenantId: string, limit: number) => Promise<string[]>
  replay: (tenantId: string, documentId: string) => Promise<unknown>
  sample?: number
  intervalMilliseconds?: number
}): () => void {
  const sample = input.sample ?? 10
  const run = async () => {
    for (const tenantId of input.tenantIds) {
      let documents: string[]
      try {
        documents = await input.recent(tenantId, sample)
      } catch {
        replays.add(1, { outcome: 'unread' })
        continue
      }
      for (const documentId of documents) {
        try {
          await input.replay(tenantId, documentId)
          replays.add(1, { outcome: 'reproduced' })
        } catch {
          replays.add(1, { outcome: 'failed' })
        }
      }
    }
  }
  const timer = setInterval(() => void run(), input.intervalMilliseconds ?? 600_000)
  timer.unref()
  const first = setTimeout(() => void run(), 30_000)
  first.unref()
  return () => {
    clearInterval(timer)
    clearTimeout(first)
  }
}

/** What `make tax-oracle` writes per year: the engine against the official calculator. */
export const oracleReportSchema = z.object({
  kind: z.string().regex(/^oracle-[a-z0-9-]{1,32}$/),
  calculatorVersion: z.string().min(1).max(40),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
  packageDigest: z.string().regex(/^[0-9a-f]{64}$/),
  documents: z.int().nonnegative(),
  lines: z.int().nonnegative(),
  agree: z.int().nonnegative(),
  differ: z.int().nonnegative(),
  refused: z.int().nonnegative(),
})

/** Records one oracle run; the same report is recorded once. */
export async function recordOracleRun(
  sql: postgres.Sql,
  input: { report: unknown; reportDigest: string; recordedBy: string },
): Promise<{ id: string; recorded: boolean }> {
  const report = oracleReportSchema.parse(input.report)
  const id = randomUUID()
  const inserted = await sql`insert into fiscal_tax_oracle_runs (
    id, kind, calculator_version, artifact_digest, package_digest, documents, lines, agreed,
    differed, refused, report_digest, recorded_by
  ) values (
    ${id}, ${report.kind.replace(/^oracle-/, '')}, ${report.calculatorVersion},
    ${report.artifactDigest}, ${report.packageDigest}, ${report.documents}, ${report.lines},
    ${report.agree}, ${report.differ}, ${report.refused}, ${input.reportDigest},
    ${input.recordedBy}
  ) on conflict (report_digest) do nothing returning id`
  return inserted[0] ? { id: String(inserted[0].id), recorded: true } : { id, recorded: false }
}

type LatestRun = {
  kind: string
  differed: number
  refused: number
  lines: number
  ageSeconds: number
}

/**
 * The last recorded run of each kind, refreshed on an interval so a scrape never waits on
 * the database: its disagreements, refusals, lines and age.
 */
export function startOracleGauges(sql: postgres.Sql, intervalMilliseconds = 60_000): () => void {
  let latest: LatestRun[] = []
  const refresh = () =>
    sql`select distinct on (kind) kind, differed, refused, lines,
        extract(epoch from now() - ran_at)::float8 as age_seconds
      from fiscal_tax_oracle_runs order by kind, sequence desc`
      .then((rows) => {
        latest = rows.map((row) => ({
          kind: String(row.kind),
          differed: Number(row.differed),
          refused: Number(row.refused),
          lines: Number(row.lines),
          ageSeconds: Number(row.age_seconds),
        }))
      })
      .catch(() => undefined)
  void refresh()
  const timer = setInterval(() => void refresh(), intervalMilliseconds)
  timer.unref()
  const gauge = (name: string, description: string, read: (run: LatestRun) => number) =>
    meter.createObservableGauge(name, { description }).addCallback((result) => {
      for (const run of latest) result.observe(read(run), { kind: run.kind })
    })
  gauge(
    'fiscal_tax_oracle_disagreements',
    'Lines the engine and the official calculator answered differently in the last run.',
    (run) => run.differed,
  )
  gauge(
    'fiscal_tax_oracle_refusals',
    'Lines the official calculator refused in the last run.',
    (run) => run.refused,
  )
  gauge('fiscal_tax_oracle_lines', 'Lines compared in the last run.', (run) => run.lines)
  gauge(
    'fiscal_tax_oracle_age_seconds',
    'Seconds since the last recorded run of the oracle.',
    (run) => run.ageSeconds,
  )
  return () => clearInterval(timer)
}
