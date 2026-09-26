import {
  type FiscalDocumentList as DocumentListPage,
  fiscalDocumentListSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'

const statusSchema = z.enum([
  'draft',
  'ready',
  'queued',
  'submitted',
  'unknown',
  'authorized',
  'rejected',
  'cancellation_pending',
  'cancellation_unknown',
  'cancelled',
])

export const documentListQuerySchema = z.strictObject({
  status: statusSchema.optional(),
  model: z.enum(['55', '65', 'nfse']).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>

/**
 * The operator worklist: every model, newest first. It reads what is pending and the last
 * rejection code, and never a tax identifier, party or XML.
 */
export class FiscalDocumentList {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 4, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async list(tenantId: string, input: DocumentListQuery): Promise<DocumentListPage> {
    z.uuid().parse(tenantId)
    const query = documentListQuerySchema.parse(input)
    const after = query.cursor ? decodeCursor(query.cursor) : null
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select d.id, d.model, d.environment, d.status, d.establishment_id, d.series,
          d.revision, d.created_at, d.intent_id, d.manual_origin_id, d.linked_origin_id,
          d.service_origin_id, reservation.number,
          coalesce((select max(t.occurred_at) from fiscal_transitions t
            where t.tenant_id = d.tenant_id and t.document_id = d.id), d.created_at) as updated_at,
          job.kind as pending_kind, job.state as pending_state,
          job.attempt_count as pending_attempts, job.next_attempt_at as pending_next,
          (select o.payload->>'rejectionCode' from fiscal_outbox o
            where o.tenant_id = d.tenant_id and o.payload->>'documentId' = d.id::text
              and o.payload ? 'rejectionCode'
            order by o.created_at desc limit 1) as rejection_code
        from fiscal_documents d
        left join fiscal_number_reservations reservation
          on reservation.tenant_id = d.tenant_id and reservation.document_id = d.id
        left join lateral (
          select command.kind, job.state, job.attempt_count, job.next_attempt_at
          from fiscal_dispatch_commands command
          join fiscal_dispatch_jobs job on job.tenant_id = command.tenant_id
            and job.command_id = command.id
          where command.tenant_id = d.tenant_id and command.document_id = d.id
            and job.state <> 'done'
          order by command.created_at desc limit 1
        ) job on true
        where d.tenant_id = ${tenantId}
          and d.environment in ('simulation', 'homologation')
          and (${query.status ?? null}::text is null or d.status = ${query.status ?? null})
          and (${query.model ?? null}::text is null or d.model = ${query.model ?? null})
          and (${after?.createdAt ?? null}::timestamptz is null
            or (d.created_at, d.id) < (${after?.createdAt ?? null}::timestamptz,
              ${after?.id ?? null}::uuid))
        order by d.created_at desc, d.id desc
        limit ${query.limit + 1}`
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return fiscalDocumentListSchema.parse({
      data: page.map(toSummary),
      page:
        rows.length > query.limit && last
          ? { hasMore: true, nextCursor: encodeCursor(instant(last.created_at), String(last.id)) }
          : { hasMore: false },
    })
  }
}

function toSummary(row: postgres.Row) {
  const id = String(row.id)
  const model = String(row.model)
  return {
    id,
    model,
    environment: row.environment,
    simulated: row.environment === 'simulation',
    fiscalValue: false,
    status: row.status,
    originKind: row.service_origin_id
      ? 'service'
      : row.linked_origin_id
        ? 'linked'
        : row.manual_origin_id
          ? 'manual'
          : 'sales',
    establishmentId: String(row.establishment_id),
    series: Number(row.series),
    number: row.number === null ? null : Number(row.number),
    revision: Number(row.revision),
    pending: row.pending_kind
      ? {
          kind: row.pending_kind,
          state: row.pending_state,
          attemptCount: Number(row.pending_attempts),
          nextAttemptAt: instant(row.pending_next),
        }
      : null,
    lastRejectionCode: row.rejection_code === null ? null : String(row.rejection_code),
    statusUrl: model === 'nfse' ? `/fiscal/service-documents/${id}` : `/fiscal/documents/${id}`,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  }
}

function instant(value: unknown): string {
  return new Date(value as string).toISOString()
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url')
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    return z
      .strictObject({ createdAt: z.iso.datetime(), id: z.uuid() })
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw new SyntaxError('Invalid Fiscal document cursor')
  }
}
