import { and, desc, eq, gte, inArray, lt, lte, type SQL, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { chainHash, GENESIS_HASH } from '@/domain/audit/chain'
import * as schema from './schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** What the audit read endpoint may narrow by (Phase 68); `before` is the cursor. */
export interface AuditFilter {
  readonly actor?: string | undefined
  readonly action?: string | undefined
  readonly subjectType?: string | undefined
  readonly subjectId?: string | undefined
  readonly from?: Date | undefined
  readonly to?: Date | undefined
  readonly before?: number | undefined
  readonly limit: number
}

export interface AuditEntryView {
  readonly sequence: number
  readonly occurredAt: string
  readonly actor: string
  readonly action: string
  readonly subjectType: string
  readonly subjectId: string
  readonly requestId: string | null
  readonly traceId: string | null
  readonly details: Record<string, unknown> | null
  readonly sealed?: boolean
  readonly hash: string
}

export interface AuditPageView {
  readonly data: readonly AuditEntryView[]
  readonly page: { readonly nextCursor?: string; readonly hasMore: boolean }
  readonly chain: {
    readonly status: 'intact' | 'broken'
    readonly checked: number
    readonly broken: readonly number[]
  }
}

/** Actors read as a user's id, `api-key:<id>` or `system`, as the page shows them. */
function actorOf(row: { actorType: string; actorId: string | null }): string {
  if (row.actorType === 'user' && row.actorId) return row.actorId
  return row.actorId ? `${row.actorType}:${row.actorId}` : row.actorType
}

function actorIs(actor: string): SQL {
  const log = schema.auditLog
  const [type, id] = actor.includes(':') ? actor.split(':', 2) : ['user', actor]
  if (actor === 'system') return eq(log.actorType, 'system')
  return and(eq(log.actorType, type ?? 'user'), sql`${log.actorId}::text = ${id ?? ''}`) as SQL
}

/** A diff sealed under a data subject's key reads as sealed, never as ciphertext (ADR 0026). */
function isSealed(value: Record<string, unknown> | null): boolean {
  return value !== null && Object.keys(value).length === 1 && 'ciphertext' in value
}

function conditionsOf(filter: AuditFilter): SQL[] {
  const log = schema.auditLog
  const conditions: SQL[] = []
  if (filter.actor) conditions.push(actorIs(filter.actor))
  if (filter.action) conditions.push(eq(log.action, filter.action))
  if (filter.subjectType) conditions.push(eq(log.subjectType, filter.subjectType))
  if (filter.subjectId) conditions.push(sql`${log.subjectId}::text = ${filter.subjectId}`)
  if (filter.from) conditions.push(gte(log.occurredAt, filter.from))
  if (filter.to) conditions.push(lte(log.occurredAt, filter.to))
  if (filter.before !== undefined) conditions.push(lt(log.sequence, filter.before))
  return conditions
}

type AuditRow = typeof schema.auditLog.$inferSelect
type Link = { readonly hash: string; readonly previousHash: string }

/** A row is sound when its hash is its own and both of its links hold. */
function isSound(row: AuditRow, links: ReadonlyMap<number, Link>): boolean {
  const recomputed = chainHash(row.previousHash, {
    sequence: row.sequence,
    tenantId: row.tenantId,
    actorType: row.actorType,
    actorId: row.actorId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    action: row.action,
    occurredAt: row.occurredAt,
    requestId: row.requestId,
    traceId: row.traceId,
    sourceIp: row.sourceIp,
    before: row.before ?? null,
    after: row.after ?? null,
    redacted: row.redacted,
  })
  const linkedBack =
    row.sequence === 1
      ? row.previousHash === GENESIS_HASH
      : links.get(row.sequence - 1)?.hash === row.previousHash
  const successor = links.get(row.sequence + 1)
  const linkedForward = !successor || successor.previousHash === row.hash
  return recomputed === row.hash && linkedBack && linkedForward
}

/**
 * One page of the tenant's audit log, newest first, with the chain's verdict on it (ADR 0025).
 *
 * Each row's hash is recomputed from its own fields, and it must link to its predecessor
 * and be linked to by its successor. A changed row fails the first test, a deleted one the
 * second, and a row re-hashed to cover a change the third — so a page never reads as
 * intact around a tampered row, whatever the filter left out.
 */
export async function readAuditPage(tx: Transaction, filter: AuditFilter): Promise<AuditPageView> {
  const log = schema.auditLog
  const rows = await tx
    .select()
    .from(log)
    .where(and(...conditionsOf(filter)))
    .orderBy(desc(log.sequence))
    .limit(filter.limit + 1)
  const page = rows.slice(0, filter.limit)
  const around = [...new Set(page.flatMap((row) => [row.sequence - 1, row.sequence + 1]))]
  const neighbours = around.length
    ? await tx
        .select({ sequence: log.sequence, hash: log.hash, previousHash: log.previousHash })
        .from(log)
        .where(inArray(log.sequence, around))
    : []
  const links = new Map(neighbours.map((row) => [row.sequence, row]))
  const broken = page.filter((row) => !isSound(row, links)).map((row) => row.sequence)
  const last = page.at(-1)
  const hasMore = rows.length > filter.limit
  return {
    data: page.map((row) => {
      const sealed = isSealed(row.before ?? null) || isSealed(row.after ?? null)
      return {
        sequence: row.sequence,
        occurredAt: row.occurredAt.toISOString(),
        actor: actorOf(row),
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        requestId: row.requestId,
        traceId: row.traceId,
        details: sealed
          ? null
          : { before: row.before ?? null, after: row.after ?? null, redacted: row.redacted },
        ...(sealed ? { sealed } : {}),
        hash: row.hash,
      }
    }),
    page: hasMore && last ? { nextCursor: String(last.sequence), hasMore } : { hasMore: false },
    chain: { status: broken.length ? 'broken' : 'intact', checked: page.length, broken },
  }
}
