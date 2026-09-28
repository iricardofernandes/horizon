import type { AuditPage, AuditQuery } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { type AuditRow, hashRow } from './audit'

const GENESIS = '0'.repeat(64)

type Link = { readonly sequence: number; readonly hash: string; readonly previous_hash: string }

/**
 * The tenant's Fiscal audit log, a page at a time, with the chain's verdict on it (Phase 68).
 *
 * Fiscal hashes a digest of each detail, never the detail, so the page shows the digest.
 * Every row's hash is recomputed and linked to its neighbours, and the newest row must be
 * the tenant's recorded head — so a changed, deleted or re-hashed row shows, even the last.
 */
export class FiscalAuditLog {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 2, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async page(tenantId: string, query: AuditQuery): Promise<AuditPage> {
    z.uuid().parse(tenantId)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const rows = (await tx`
        select tenant_id, sequence, id, actor_id, action, resource_id, detail_digest, occurred_at,
          previous_hash, hash
        from fiscal_audit_entries
        where true
          ${query.actor ? tx`and actor_id = ${query.actor}` : tx``}
          ${query.action ? tx`and action = ${query.action}` : tx``}
          ${query.subjectId ? tx`and resource_id::text = ${query.subjectId}` : tx``}
          ${query.from ? tx`and occurred_at >= ${query.from}` : tx``}
          ${query.to ? tx`and occurred_at <= ${query.to}` : tx``}
          ${query.cursor ? tx`and sequence < ${query.cursor}` : tx``}
          ${query.subjectType && query.subjectType !== 'document' ? tx`and false` : tx``}
        order by sequence desc
        limit ${query.limit + 1}`) as unknown as AuditRow[]
      const page = rows.slice(0, query.limit)
      const around = [
        ...new Set(page.flatMap((row) => [Number(row.sequence) - 1, Number(row.sequence) + 1])),
      ]
      const links = around.length
        ? ((await tx`select sequence::int as sequence, hash, previous_hash
            from fiscal_audit_entries where sequence = any(${around})`) as unknown as Link[])
        : []
      const [head] = (await tx`select sequence::int as sequence, hash
        from fiscal_audit_heads`) as unknown as { sequence: number; hash: string }[]
      const bySequence = new Map(links.map((link) => [Number(link.sequence), link]))
      const broken = page
        .filter((row) => {
          const sequence = Number(row.sequence)
          const predecessor = bySequence.get(sequence - 1)
          const successor = bySequence.get(sequence + 1)
          const linkedBack =
            sequence === 1 ? row.previous_hash === GENESIS : predecessor?.hash === row.previous_hash
          const linkedForward = successor
            ? successor.previous_hash === row.hash
            : head !== undefined && head.sequence === sequence && head.hash === row.hash
          return hashRow(row) !== row.hash || !linkedBack || !linkedForward
        })
        .map((row) => Number(row.sequence))
      const last = page.at(-1)
      const hasMore = rows.length > query.limit
      return {
        data: page.map((row) => ({
          sequence: Number(row.sequence),
          occurredAt: new Date(row.occurred_at).toISOString(),
          actor: row.actor_id,
          action: row.action,
          subjectType: 'document',
          subjectId: row.resource_id,
          requestId: null,
          traceId: null,
          details: { digest: row.detail_digest },
          hash: row.hash,
        })),
        page: hasMore && last ? { nextCursor: String(last.sequence), hasMore } : { hasMore: false },
        chain: { status: broken.length ? 'broken' : 'intact', checked: page.length, broken },
      }
    })
  }
}
