import type postgres from 'postgres'
import { cutoffOf, type RetentionPolicy, type RetentionRule } from './policy.js'

export type Sql = ReturnType<typeof postgres>

export interface RemovedCount {
  readonly class: RetentionRule['class']
  readonly database: string
  readonly table: string
  readonly tenant: string
  readonly removed: number
  readonly olderThan: string
}

export type Log = (line: Record<string, unknown>) => void

/**
 * Removes one rule's rows older than its age, in batches, counting them per tenant. Each
 * batch is its own statement, so a long backlog never holds one long transaction.
 */
export async function applyRule(
  sql: Sql,
  rule: RetentionRule,
  now: Date,
  batchSize: number,
): Promise<RemovedCount[]> {
  const cutoff = cutoffOf(rule, now)
  const table = sql(rule.table)
  const age = sql(rule.ageColumn)
  const perTenant = new Map<string, number>()
  for (;;) {
    const removed = await sql<{ tenant_id: string }[]>`
      delete from ${table}
      where ${age} in (
        select ${age} from ${table} where ${age} < ${cutoff} order by ${age} limit ${batchSize}
      )
      returning tenant_id`
    for (const row of removed)
      perTenant.set(String(row.tenant_id), (perTenant.get(String(row.tenant_id)) ?? 0) + 1)
    if (removed.length < batchSize) break
  }
  return [...perTenant].map(([tenant, removed]) => ({
    class: rule.class,
    database: rule.database,
    table: rule.table,
    tenant,
    removed,
    olderThan: cutoff.toISOString(),
  }))
}

export interface Connections {
  database(name: string): Sql
}

export interface Reporter {
  /** Rows other workers should already have removed, per database and tenant. */
  overdue(now: Date, graceMinutes: number): Promise<Record<string, number>>
  /** Keys under the prefixes that would never expire. */
  keysWithoutTtl(prefixes: readonly string[]): Promise<Record<string, number>>
}

/**
 * One retention run (ADR 0063): every rule applied, one log line per class, table and
 * tenant, and a summary with what is only reported. A rule that fails is logged and the
 * others still run.
 */
export async function runRetention(
  policy: RetentionPolicy,
  connections: Connections,
  reporter: Reporter,
  log: Log,
  now = new Date(),
): Promise<{ removed: number; failed: string[] }> {
  const started = Date.now()
  let removed = 0
  const failed: string[] = []
  for (const rule of policy.rules) {
    try {
      const counts = await applyRule(
        connections.database(rule.database),
        rule,
        now,
        policy.batchSize,
      )
      for (const count of counts) {
        removed += count.removed
        log({ event: 'retention.removed', ...count })
      }
    } catch (error) {
      failed.push(`${rule.database}.${rule.table}`)
      log({
        event: 'retention.failed',
        database: rule.database,
        table: rule.table,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const [overdue, withoutTtl] = await Promise.all([
    reporter.overdue(now, policy.reports.overdueGraceMinutes).catch(() => null),
    reporter.keysWithoutTtl(policy.reports.redisPrefixes).catch(() => null),
  ])
  log({
    event: 'retention.run',
    removed,
    failed,
    overdue,
    keysWithoutTtl: withoutTtl,
    durationMs: Date.now() - started,
  })
  return { removed, failed }
}
