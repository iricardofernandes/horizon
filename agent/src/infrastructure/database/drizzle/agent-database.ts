import { createHash } from 'node:crypto'
import { context, trace } from '@opentelemetry/api'
import { and, desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { uuidv7 } from 'uuidv7'
import { AgentStore, type AuditRecord } from '@/application/ports'
import { canonicalJson } from '@/core/audit/canonical-json'
import { type AuditFilter, type AuditPageView, readAuditPage } from './audit-reader'
import * as schema from './schema'
import type { Database, Transaction } from './transaction'

export interface AgentDatabaseOptions {
  readonly url: string
  readonly poolMax?: number
  readonly statementTimeoutMs?: number
}

const GENESIS_HASH = '0'.repeat(64)

/** `hash = sha256(previous_hash || canonical_json(entry))`, as identity's chain (ADR 0025). */
export function auditHash(previousHash: string, entry: Record<string, unknown>): string {
  return createHash('sha256')
    .update(previousHash, 'utf8')
    .update(canonicalJson(entry), 'utf8')
    .digest('hex')
}

async function appendAudit(tx: Transaction, tenantId: string, record: AuditRecord) {
  // A per-tenant transaction lock serializes chain appends, including the first link.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`agent.audit:${tenantId}`}, 0))`,
  )
  const [last] = await tx
    .select({ sequence: schema.auditLog.sequence, hash: schema.auditLog.hash })
    .from(schema.auditLog)
    .orderBy(desc(schema.auditLog.sequence))
    .limit(1)
  const entry = {
    sequence: (last?.sequence ?? 0) + 1,
    tenantId,
    actor: record.actor,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    action: record.action,
    occurredAt: record.occurredAt,
    requestId: null,
    traceId: trace.getSpan(context.active())?.spanContext().traceId ?? null,
    details: JSON.parse(canonicalJson(record.details)) as Record<string, unknown>,
  }
  const previousHash = last?.hash ?? GENESIS_HASH
  await tx
    .insert(schema.auditLog)
    .values({ id: uuidv7(), ...entry, previousHash, hash: auditHash(previousHash, entry) })
}

/** Owns the connection; every read and write is bound to one tenant (ADR 0017). */
export class AgentDatabase extends AgentStore {
  readonly #client: ReturnType<typeof postgres>
  readonly #db: Database

  constructor(options: AgentDatabaseOptions) {
    super()
    this.#client = postgres(options.url, {
      max: options.poolMax ?? 10,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
    this.#db = drizzle(this.#client, { schema })
  }

  private inTenant<T>(tenantId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenantId}, true)`)
      return work(tx)
    })
  }

  accessEnabled(tenantId: string): Promise<boolean> {
    return this.inTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ enabled: schema.agentSettings.enabled })
        .from(schema.agentSettings)
        .where(eq(schema.agentSettings.tenantId, tenantId))
      return row?.enabled === true
    })
  }

  /** The switch and its audit entry, in one transaction. */
  setAccess(tenantId: string, enabled: boolean, by: string, at: Date): Promise<void> {
    return this.inTenant(tenantId, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
      await tx
        .insert(schema.agentSettings)
        .values({ tenantId, enabled, updatedBy: by, updatedAt: at })
        .onConflictDoUpdate({
          target: schema.agentSettings.tenantId,
          set: { enabled, updatedBy: by, updatedAt: at },
        })
      await appendAudit(tx, tenantId, {
        actor: by,
        subjectType: 'agent-settings',
        subjectId: tenantId,
        action: enabled ? 'agent.access.enabled' : 'agent.access.disabled',
        occurredAt: at,
        details: { enabled },
      })
    })
  }

  audit(tenantId: string, record: AuditRecord): Promise<void> {
    return this.inTenant(tenantId, async (tx) => {
      await tx.insert(schema.tenants).values({ id: tenantId }).onConflictDoNothing()
      await appendAudit(tx, tenantId, record)
    })
  }

  /** The workspace's switch as the settings screen shows it. */
  settings(
    tenantId: string,
  ): Promise<{ enabled: boolean; updatedBy: string | null; updatedAt: string | null }> {
    return this.inTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.agentSettings)
        .where(eq(schema.agentSettings.tenantId, tenantId))
      return {
        enabled: row?.enabled === true,
        updatedBy: row?.updatedBy ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      }
    })
  }

  /**
   * The records the tenant's agents drafted in one module, newest first (ADR 0066): read
   * from the calls' own audit entries, so there is one place that says an agent made them.
   */
  drafts(
    tenantId: string,
    module: string,
    type: string | undefined,
    limit: number,
  ): Promise<
    { recordId: string; type: string; keyId: string; sequence: number; occurredAt: string }[]
  > {
    return this.inTenant(tenantId, async (tx) => {
      const log = schema.auditLog
      const rows = await tx
        .select({
          sequence: log.sequence,
          occurredAt: log.occurredAt,
          actor: log.actor,
          record: sql<{ module: string; type: string; id: string }>`${log.details} -> 'record'`,
        })
        .from(log)
        .where(
          and(
            eq(log.action, 'agent.tool.called'),
            sql`${log.details} -> 'record' ->> 'module' = ${module}`,
            ...(type ? [sql`${log.details} -> 'record' ->> 'type' = ${type}`] : []),
          ),
        )
        .orderBy(desc(log.sequence))
        .limit(limit)
      return rows.map((row) => ({
        recordId: row.record.id,
        type: row.record.type,
        keyId: row.actor.replace(/^api-key:/, ''),
        sequence: row.sequence,
        occurredAt: row.occurredAt.toISOString(),
      }))
    })
  }

  /** A page of the tenant's audit log, with the chain's verdict on it (Phase 68). */
  auditPage(tenantId: string, filter: AuditFilter): Promise<AuditPageView> {
    return this.inTenant(tenantId, (tx) => readAuditPage(tx, filter))
  }

  async ping(): Promise<void> {
    await this.#db.execute(sql`select 1`)
  }

  async close(): Promise<void> {
    await this.#client.end({ timeout: 5 })
  }
}
