import type { FiscalDocumentLinks } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { canonicalDigest } from './canonical-json'
import { formatQuantity, quantity } from './inbound-matching'

type Transaction = postgres.TransactionSql
type Linked = FiscalDocumentLinks['linked'][number]

/**
 * What a document references, what references it, and the ids the owners of stock and
 * money key their effects by. Fiscal only reads these correlations; it never acts on them.
 */
export class FiscalDocumentLinksReader {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async read(tenantId: string, documentId: string): Promise<FiscalDocumentLinks | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [document] = await tx`select linked_origin_id from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
      if (!document) return null
      const own = document.linked_origin_id ? String(document.linked_origin_id) : null
      const originIds = own
        ? [own]
        : (
            await tx`select distinct linked_origin_id from fiscal_linked_references
              where tenant_id = ${tenantId} and referenced_document_id = ${documentId}
              order by linked_origin_id`
          ).map((row) => String(row.linked_origin_id))
      const linked: Linked[] = []
      const correlations: FiscalDocumentLinks['correlations'] = []
      for (const originId of originIds) {
        const origin = await readOrigin(tx, tenantId, originId)
        linked.push(origin.view)
        correlations.push(...(await correlationsOf(tx, tenantId, origin)))
      }
      const references = own
        ? (
            await tx`select referenced_document_id, referenced_import_id
              from fiscal_linked_references where tenant_id = ${tenantId}
                and linked_origin_id = ${own} order by position`
          ).map((row) =>
            row.referenced_document_id
              ? { type: 'document' as const, documentId: String(row.referenced_document_id) }
              : { type: 'supplier-invoice' as const, importId: String(row.referenced_import_id) },
          )
        : []
      const view = {
        documentId,
        kind: own ? (linked[0]?.kind ?? 'sale') : ('sale' as const),
        references,
        linked,
        correlations,
      }
      return { ...view, digest: canonicalDigest(view) }
    })
  }
}

async function readOrigin(tx: Transaction, tenantId: string, originId: string) {
  const [origin] = await tx`select kind, correlation_id from fiscal_linked_origins
    where tenant_id = ${tenantId} and id = ${originId}`
  if (!origin) throw new Error('Fiscal linked origin not found')
  const [latest] = await tx`select id, status from fiscal_documents
    where tenant_id = ${tenantId} and linked_origin_id = ${originId}
    order by revision desc limit 1`
  const lines = await tx`select line_id, item_id, reference_key, reference_quantity::text,
      quantity::text, amount_minor::text, currency
    from fiscal_linked_origin_lines where tenant_id = ${tenantId}
      and linked_origin_id = ${originId} order by line_id, reference_key`
  const view: Linked = {
    linkedOriginId: originId,
    kind: origin.kind as Linked['kind'],
    documentId: latest ? String(latest.id) : null,
    status: latest ? String(latest.status) : null,
    void: latest?.status === 'cancelled',
    lines: lines.map((line) => ({
      lineId: String(line.line_id),
      itemId: String(line.item_id),
      referenceKey: String(line.reference_key),
      referenceQuantity:
        line.reference_quantity === null ? null : normalize(String(line.reference_quantity)),
      quantity: normalize(String(line.quantity)),
      amount: { amount: String(line.amount_minor), currency: String(line.currency) },
    })),
  }
  return {
    view,
    kind: view.kind,
    correlationId: origin.correlation_id ? String(origin.correlation_id) : null,
  }
}

async function correlationsOf(
  tx: Transaction,
  tenantId: string,
  origin: Awaited<ReturnType<typeof readOrigin>>,
): Promise<FiscalDocumentLinks['correlations']> {
  if (!origin.correlationId) return []
  if (origin.kind === 'sale-return')
    return (['inventory', 'financial'] as const).map((module) => ({
      module,
      sourceEvent: 'sales.shipment.returned',
      correlationId: origin.correlationId as string,
      observedIds: [],
    }))
  const reversed = await tx`select title_id from fiscal_purchase_payables
    where tenant_id = ${tenantId} and receipt_id = ${origin.correlationId}
      and reversed_at is not null order by title_id`
  return [
    {
      module: 'inventory',
      sourceEvent: 'procurement.receipt.returned',
      correlationId: origin.correlationId,
      observedIds: [],
    },
    {
      module: 'financial',
      sourceEvent: 'procurement.receipt.returned',
      correlationId: origin.correlationId,
      observedIds: reversed.map((row) => String(row.title_id)),
    },
  ]
}

function normalize(value: string): string {
  return formatQuantity(quantity(value))
}
