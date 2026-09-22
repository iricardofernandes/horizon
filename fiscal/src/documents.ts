import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'

const draftInputSchema = z.object({
  tenantId: z.uuid(),
  intentId: z.uuid(),
  model: z.enum(['55', '65', 'nfse']),
  environment: z.literal('simulation'),
  establishmentId: z.uuid(),
  series: z.int().min(0).max(999),
  snapshot: z.record(z.string(), z.unknown()),
})

export type DraftInput = z.infer<typeof draftInputSchema>
export type Draft = { id: string; status: 'draft'; snapshotDigest: string }

/** Internal Phase 40 persistence. Public issuance remains unavailable. */
export class FiscalDocuments {
  readonly #db: ReturnType<typeof postgres>

  constructor(url: string) {
    this.#db = postgres(url, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async createDraft(input: DraftInput): Promise<Draft> {
    const value = draftInputSchema.parse(input)
    const snapshot = JSON.stringify(value.snapshot)
    const digest = createHash('sha256').update(snapshot).digest('hex')
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const id = randomUUID()
      const inserted = await tx`
        insert into fiscal_documents (
          id, tenant_id, intent_id, model, environment, establishment_id, series,
          snapshot_digest
        ) values (
          ${id}, ${value.tenantId}, ${value.intentId}, ${value.model},
          ${value.environment}, ${value.establishmentId}, ${value.series}, ${digest}
        ) on conflict on constraint fiscal_documents_intent_key do nothing returning id`
      if (inserted.length > 0) {
        await tx`insert into fiscal_transitions
          (id, tenant_id, document_id, kind) values
          (${randomUUID()}, ${value.tenantId}, ${id}, 'draft_created')`
        return { id, status: 'draft' as const, snapshotDigest: digest }
      }
      const [existing] = await tx`
        select id, model, environment, establishment_id, series, snapshot_digest
        from fiscal_documents where tenant_id = ${value.tenantId}
          and intent_id = ${value.intentId}`
      if (
        !existing ||
        existing.model !== value.model ||
        existing.environment !== value.environment ||
        existing.establishment_id !== value.establishmentId ||
        existing.series !== value.series ||
        existing.snapshot_digest !== digest
      )
        throw new Error('Conflicting fiscal draft for this origin')
      return { id: String(existing.id), status: 'draft' as const, snapshotDigest: digest }
    })
  }

  async reserveNumber(tenantId: string, documentId: string): Promise<number> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      // Serialize retries for one document before incrementing a series counter.
      await tx`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${documentId}, 0))`
      const [document] = await tx`
        select model, environment, establishment_id, series from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
      if (!document) throw new Error('Fiscal document not found')
      if (document.environment !== 'simulation')
        throw new Error('Fiscal number reservation is enabled only in simulation')
      const [existing] = await tx`
        select number from fiscal_number_reservations
        where tenant_id = ${tenantId} and document_id = ${documentId}`
      if (existing) return Number(existing.number)
      const [counter] = await tx`
        insert into fiscal_number_counters (
          tenant_id, establishment_id, environment, model, series, last_number
        ) values (
          ${tenantId}, ${document.establishment_id}, ${document.environment},
          ${document.model}, ${document.series}, 1
        ) on conflict (tenant_id, establishment_id, environment, model, series)
        do update set last_number = fiscal_number_counters.last_number + 1
        returning last_number`
      if (!counter) throw new Error('Could not reserve a fiscal number')
      const number = Number(counter.last_number)
      await tx`
        insert into fiscal_number_reservations (
          tenant_id, document_id, establishment_id, environment, model, series, number
        ) values (
          ${tenantId}, ${documentId}, ${document.establishment_id},
          ${document.environment}, ${document.model}, ${document.series}, ${number}
        )`
      await tx`
        insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
        values (${randomUUID()}, ${tenantId}, ${documentId}, 'number_reserved',
          ${JSON.stringify({ number })}::jsonb)`
      return number
    })
  }
}
