import { createHash, randomUUID } from 'node:crypto'
import {
  type FiscalLinkedOriginRequest,
  type FiscalLinkedProblemCode,
  fiscalLinkedOriginRequestSchema,
  salesFiscalOriginRecorded,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import type { OwnerFiscalClient } from './backfill'
import { canonicalDigest, canonicalJson } from './canonical-json'
import { supportedKind, UnsupportedDocumentKind } from './document-kinds'
import type { FiscalDocuments } from './documents'
import { formatQuantity, quantity } from './inbound-matching'
import { openOrigin, sealOrigin } from './origin-crypto'
import {
  type LinkedOriginPayload,
  linkedOriginPayloadSchema,
  parseFiscalOriginSnapshot,
} from './origin-snapshot'

type Transaction = postgres.TransactionSql
type Line = LinkedOriginPayload['lines'][number]
type Frozen = Omit<LinkedOriginPayload, 'originId' | 'lines' | 'total'> & {
  sourceRecordId: string | null
  correlationId: string | null
  lines: Line[]
}

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
  request: fiscalLinkedOriginRequestSchema,
})
const itemSchema = z.object({ id: z.uuid(), name: z.string().min(1).max(160) })
const SCALE = 1_000_000n

export class LinkedOriginError extends Error {
  constructor(
    readonly code: FiscalLinkedProblemCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Freezes the owner facts a return or complement is derived from, and holds the returned
 * quantities against the original lines. The database trigger checks the same
 * conservation again, so a race between two requests cannot over-return.
 */
export class FiscalLinkedOrigins {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly documents: Pick<FiscalDocuments, 'readSnapshot'>,
    private readonly ownerForTenant: (tenantId: string) => Pick<OwnerFiscalClient, 'catalogItem'>,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal linked-origin key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async create(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    try {
      supportedKind(command.request.kind)
    } catch (error) {
      if (error instanceof UnsupportedDocumentKind)
        throw new LinkedOriginError('KIND_UNSUPPORTED', error.message)
      throw error
    }
    const requestDigest = canonicalDigest(command.request)
    const prepared = await this.prepare(command.tenantId, command.request)
    try {
      return await this.#db.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:linked:${command.idempotencyKey}`}, 0))`
        const prior = await findByKey(tx, command.tenantId, command.idempotencyKey)
        if (prior) {
          if (prior.requestDigest !== requestDigest)
            throw new LinkedOriginError('LINKED_ORIGIN_CONFLICT', 'Conflicting idempotency key')
          return { ...prior.origin, existing: true }
        }
        const frozen = await this.freeze(tx, command.tenantId, command.request, prepared)
        const bySource = frozen.sourceRecordId
          ? await findBySource(tx, command.tenantId, command.request.kind, frozen.sourceRecordId)
          : null
        const origin = bySource ?? (await this.insert(tx, command, frozen))
        await tx`insert into fiscal_linked_origin_idempotency
          (tenant_id, idempotency_key, request_digest, linked_origin_id)
          values (${command.tenantId}, ${command.idempotencyKey}, ${requestDigest}, ${origin.id})`
        return { ...origin, existing: bySource !== null }
      })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23514')
        throw error.message.includes('exceeds')
          ? new LinkedOriginError('QUANTITY_EXCEEDED', 'Linked quantity exceeds the original')
          : new LinkedOriginError('REFERENCE_NOT_AUTHORIZED', error.message)
      throw error
    }
  }

  async kindOf(tenantId: string, linkedOriginId: string): Promise<Frozen['kind'] | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(linkedOriginId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select kind from fiscal_linked_origins
        where tenant_id = ${tenantId} and id = ${linkedOriginId}`
    })
    return row ? (String(row.kind) as Frozen['kind']) : null
  }

  /** Reads what cannot be read inside the locked transaction (other services, owners). */
  private async prepare(tenantId: string, request: FiscalLinkedOriginRequest) {
    if (request.kind === 'purchase-return') {
      const rows = await this.#db.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${tenantId}, true)`
        return tx`select item_id from fiscal_purchase_receipt_lines
          where tenant_id = ${tenantId} and receipt_id = ${request.receiptId}
            and returned_quantity > 0`
      })
      const names = new Map<string, string>()
      for (const row of rows) {
        const itemId = String(row.item_id)
        if (names.has(itemId)) continue
        const item = itemSchema.parse(await this.ownerForTenant(tenantId).catalogItem(itemId))
        if (item.id !== itemId) throw new Error('Catalog item identity mismatch')
        names.set(itemId, item.name)
      }
      return { names, original: null }
    }
    const originalId =
      request.kind === 'value-complement'
        ? request.referencedDocumentId
        : await this.originalForReturn(tenantId, request.shipmentId)
    const snapshot = originalId
      ? parseFiscalOriginSnapshot(await this.documents.readSnapshot(tenantId, originalId))
      : null
    return {
      names: new Map<string, string>(),
      original: originalId ? { originalId, snapshot } : null,
    }
  }

  private async originalForReturn(tenantId: string, shipmentId: string): Promise<string | null> {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select document.id from fiscal_intents original
        join fiscal_documents document on document.tenant_id = original.tenant_id
          and document.intent_id = original.id
        where original.tenant_id = ${tenantId} and original.origin_module = 'sales'
          and original.origin_document_type = 'shipment' and original.origin_id = ${shipmentId}
          and original.purpose = 'original'
        order by (document.status = 'authorized') desc, document.revision desc limit 1`
    })
    return row ? String(row.id) : null
  }

  private async freeze(
    tx: Transaction,
    tenantId: string,
    request: FiscalLinkedOriginRequest,
    prepared: Awaited<ReturnType<FiscalLinkedOrigins['prepare']>>,
  ): Promise<Frozen> {
    switch (request.kind) {
      case 'sale-return':
        return this.freezeSaleReturn(tx, tenantId, request.shipmentId, prepared.original)
      case 'purchase-return':
        return freezePurchaseReturn(tx, tenantId, request, prepared.names)
      case 'value-complement':
        return freezeComplement(tx, tenantId, request, prepared.original)
    }
  }

  private async freezeSaleReturn(
    tx: Transaction,
    tenantId: string,
    shipmentId: string,
    original: {
      originalId: string
      snapshot: ReturnType<typeof parseFiscalOriginSnapshot> | null
    } | null,
  ): Promise<Frozen> {
    const [intent] = await tx`select intent.id, intent.origin_id, payload.payload_ciphertext,
        payload.payload_digest from fiscal_intents intent
      join fiscal_origin_payloads payload on payload.tenant_id = intent.tenant_id
        and payload.intent_id = intent.id
      where intent.tenant_id = ${tenantId} and intent.origin_module = 'sales'
        and intent.origin_document_type = 'shipment' and intent.origin_id = ${shipmentId}
        and intent.purpose = 'return'`
    if (!intent) throw new LinkedOriginError('SOURCE_NOT_PROJECTED', 'Sales return is unknown')
    const intentId = String(intent.id)
    const plaintext = openOrigin(
      this.masterKey,
      tenantId,
      intentId,
      Buffer.from(intent.payload_ciphertext),
    )
    if (createHash('sha256').update(plaintext).digest('hex') !== intent.payload_digest)
      throw new Error('Fiscal return origin digest mismatch')
    const returned = salesFiscalOriginRecorded.payload.parse(JSON.parse(plaintext))
    if (returned.purpose !== 'return' || returned.originId !== intent.origin_id)
      throw new Error('Fiscal return origin identity mismatch')
    if (original?.snapshot?.originModule !== 'sales')
      throw new LinkedOriginError('REFERENCE_NOT_AUTHORIZED', 'The shipment has no sale document')
    const reference = await lockAuthorizedOriginal(tx, tenantId, original.originalId)
    const originalLines = new Map(original.snapshot.lines.map((line) => [line.lineId, line]))
    const lines = returned.lines.map((line) => {
      const sold = originalLines.get(line.lineId)
      if (!sold || sold.itemId !== line.itemId || sold.unitPrice.amount !== line.unitPrice.amount)
        throw new LinkedOriginError('REFERENCE_INCOMPLETE', 'Returned line is not on the sale')
      if (quantity(line.quantity) > quantity(sold.quantity))
        throw new LinkedOriginError('QUANTITY_EXCEEDED', 'Returned more than was sold')
      return {
        lineId: line.lineId,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        references: [
          {
            referenceKey: `document:${original.originalId}:${line.lineId}`,
            referenceQuantity: sold.quantity,
            quantity: line.quantity,
          },
        ],
      }
    })
    return {
      originModule: 'fiscal',
      originDocumentType: 'linked',
      purpose: 'linked',
      kind: 'sale-return',
      customerId: returned.customerId,
      establishmentId: reference.establishmentId,
      source: { module: 'sales', documentType: 'shipment', id: returned.originId },
      references: [
        { type: 'document', documentId: original.originalId, accessKey: reference.accessKey },
      ],
      reasonDigest: null,
      sourceRecordId: intentId,
      correlationId: returned.originId,
      lines,
    }
  }

  private async insert(
    tx: Transaction,
    command: z.infer<typeof commandSchema>,
    frozen: Frozen,
  ): Promise<{ id: string; kind: Frozen['kind']; digest: string; createdAt: string }> {
    const id = randomUUID()
    const { sourceRecordId, correlationId, ...fields } = frozen
    const currency = frozen.lines[0]?.lineTotal.currency ?? 'BRL'
    const total = frozen.lines.reduce((sum, line) => sum + BigInt(line.lineTotal.amount), 0n)
    const payload = linkedOriginPayloadSchema.parse({
      ...fields,
      originId: id,
      total: { amount: total.toString(), currency },
    })
    const plaintext = canonicalJson(payload)
    const digest = createHash('sha256').update(plaintext).digest('hex')
    await tx`insert into fiscal_linked_origins (
        id, tenant_id, kind, source_module, source_id, correlation_id, establishment_id,
        recipient_party_id, actor_id, reason_digest, payload_ciphertext, payload_digest
      ) values (
        ${id}, ${command.tenantId}, ${frozen.kind}, ${frozen.source.module}, ${sourceRecordId},
        ${correlationId}, ${frozen.establishmentId}, ${frozen.customerId}, ${command.actorId},
        ${frozen.reasonDigest}, ${sealOrigin(this.masterKey, command.tenantId, id, plaintext)},
        ${digest}
      )`
    for (const [index, reference] of frozen.references.entries())
      await tx`insert into fiscal_linked_references (
          tenant_id, linked_origin_id, position, referenced_document_id, referenced_import_id
        ) values (
          ${command.tenantId}, ${id}, ${index + 1},
          ${reference.type === 'document' ? reference.documentId : null},
          ${reference.type === 'supplier-invoice' ? reference.importId : null}
        )`
    for (const line of frozen.lines)
      for (const reference of line.references)
        await tx`insert into fiscal_linked_origin_lines (
            tenant_id, linked_origin_id, line_id, item_id, reference_key, reference_quantity,
            quantity, amount_minor, currency
          ) values (
            ${command.tenantId}, ${id}, ${line.lineId}, ${line.itemId}, ${reference.referenceKey},
            ${reference.referenceQuantity}, ${reference.quantity},
            ${reference.referenceQuantity === null ? line.lineTotal.amount : shareOf(line, reference.quantity)},
            ${line.lineTotal.currency}
          )`
    await appendAudit(tx, {
      tenantId: command.tenantId,
      actorId: command.actorId,
      action: 'linked-origin.created',
      resourceId: id,
      detail: { kind: frozen.kind, payloadDigest: digest },
    })
    const [saved] = await tx`select created_at from fiscal_linked_origins
      where tenant_id = ${command.tenantId} and id = ${id}`
    return { id, kind: frozen.kind, digest, createdAt: new Date(saved?.created_at).toISOString() }
  }
}

async function freezePurchaseReturn(
  tx: Transaction,
  tenantId: string,
  request: Extract<FiscalLinkedOriginRequest, { kind: 'purchase-return' }>,
  names: Map<string, string>,
): Promise<Frozen> {
  const [receipt] = await tx`select supplier_id, returned_at from fiscal_purchase_receipts
    where tenant_id = ${tenantId} and receipt_id = ${request.receiptId} for share`
  if (!receipt || receipt.returned_at === null)
    throw new LinkedOriginError('SOURCE_NOT_PROJECTED', 'No projected return for this receipt')
  const receiptLines = await tx`select line_id, item_id, returned_quantity::text,
      unit_price_minor::text, currency from fiscal_purchase_receipt_lines
    where tenant_id = ${tenantId} and receipt_id = ${request.receiptId}
      and returned_quantity > 0 order by line_id`
  // Allocations in commit order: a return consumes the invoice lines it was matched to.
  const allocations = await tx`select allocation.receipt_line_id, allocation.line_number,
      allocation.quantity::text, reconciliation.import_id, reconciliation.supplier_party_id,
      imported.access_key,
      (select sum(total.quantity) from fiscal_inbound_reconciliation_lines total
        where total.tenant_id = allocation.tenant_id
          and total.reconciliation_id = allocation.reconciliation_id
          and total.line_number = allocation.line_number)::text as invoice_line_quantity
    from fiscal_inbound_reconciliation_lines allocation
    join fiscal_inbound_reconciliations reconciliation
      on reconciliation.tenant_id = allocation.tenant_id
      and reconciliation.id = allocation.reconciliation_id
    join fiscal_inbound_documents imported on imported.tenant_id = reconciliation.tenant_id
      and imported.id = reconciliation.import_id
    where allocation.tenant_id = ${tenantId} and allocation.receipt_id = ${request.receiptId}
    order by reconciliation.reviewed_at, reconciliation.id, allocation.line_number`
  if (allocations.some((row) => row.supplier_party_id !== receipt.supplier_id))
    throw new LinkedOriginError('REFERENCE_INCOMPLETE', 'Reconciled supplier differs from receipt')
  const references = new Map<string, { importId: string; accessKey: string }>()
  const lines = receiptLines.map((row) => {
    let remaining = quantity(String(row.returned_quantity))
    const lineReferences: Line['references'] = []
    for (const allocation of allocations.filter((entry) => entry.receipt_line_id === row.line_id)) {
      if (remaining === 0n) break
      const taken = min(remaining, quantity(String(allocation.quantity)))
      remaining -= taken
      references.set(String(allocation.import_id), {
        importId: String(allocation.import_id),
        accessKey: String(allocation.access_key),
      })
      lineReferences.push({
        referenceKey: `import:${allocation.import_id}:${allocation.line_number}`,
        referenceQuantity: formatQuantity(quantity(String(allocation.invoice_line_quantity))),
        quantity: formatQuantity(taken),
      })
    }
    if (remaining > 0n || lineReferences.length === 0)
      throw new LinkedOriginError(
        'REFERENCE_INCOMPLETE',
        'The returned quantity is not covered by a reconciled supplier NF-e',
      )
    const itemId = String(row.item_id)
    const description = names.get(itemId)
    if (!description) throw new Error('Catalog item name is unavailable')
    const returned = String(row.returned_quantity)
    const unitPrice = { amount: String(row.unit_price_minor), currency: String(row.currency) }
    return {
      lineId: String(row.line_id),
      itemId,
      description,
      quantity: formatQuantity(quantity(returned)),
      unitPrice,
      lineTotal: {
        amount: roundedTotal(quantity(returned), BigInt(unitPrice.amount)).toString(),
        currency: unitPrice.currency,
      },
      references: lineReferences,
    }
  })
  if (lines.length === 0)
    throw new LinkedOriginError('SOURCE_NOT_PROJECTED', 'The return has no returned lines')
  return {
    originModule: 'fiscal',
    originDocumentType: 'linked',
    purpose: 'linked',
    kind: 'purchase-return',
    customerId: String(receipt.supplier_id),
    establishmentId: request.establishmentId,
    source: { module: 'procurement', documentType: 'receipt', id: request.receiptId },
    references: [...references.values()].map((reference) => ({
      type: 'supplier-invoice' as const,
      ...reference,
    })),
    reasonDigest: null,
    sourceRecordId: request.receiptId,
    correlationId: request.receiptId,
    lines,
  }
}

async function freezeComplement(
  tx: Transaction,
  tenantId: string,
  request: Extract<FiscalLinkedOriginRequest, { kind: 'value-complement' }>,
  original: {
    originalId: string
    snapshot: ReturnType<typeof parseFiscalOriginSnapshot> | null
  } | null,
): Promise<Frozen> {
  if (
    !original?.snapshot ||
    (original.snapshot.originModule === 'fiscal' && original.snapshot.purpose === 'linked')
  )
    throw new LinkedOriginError('REFERENCE_NOT_AUTHORIZED', 'Only a sale can be complemented')
  const reference = await lockAuthorizedOriginal(tx, tenantId, original.originalId)
  const sold = new Map(original.snapshot.lines.map((line) => [line.lineId, line]))
  const seen = new Set<string>()
  const lines = request.lines.map((line) => {
    const originalLine = sold.get(line.lineId)
    if (!originalLine || seen.has(line.lineId))
      throw new LinkedOriginError('REFERENCE_INCOMPLETE', 'Complemented line is not on the sale')
    seen.add(line.lineId)
    if (line.amount.currency !== 'BRL' || BigInt(line.amount.amount) <= 0n)
      throw new LinkedOriginError(
        'REFERENCE_INCOMPLETE',
        'A complement must add a positive BRL value',
      )
    return {
      lineId: line.lineId,
      itemId: originalLine.itemId,
      description: originalLine.description,
      quantity: '0',
      unitPrice: { amount: '0', currency: 'BRL' },
      lineTotal: line.amount,
      references: [
        {
          referenceKey: `document:${original.originalId}:${line.lineId}`,
          referenceQuantity: null,
          quantity: '0',
        },
      ],
    }
  })
  return {
    originModule: 'fiscal',
    originDocumentType: 'linked',
    purpose: 'linked',
    kind: 'value-complement',
    customerId: original.snapshot.customerId,
    establishmentId: reference.establishmentId,
    source: { module: 'fiscal', documentType: 'review', id: original.originalId },
    references: [
      { type: 'document', documentId: original.originalId, accessKey: reference.accessKey },
    ],
    reasonDigest: createHash('sha256').update(request.reason).digest('hex'),
    sourceRecordId: null,
    correlationId: null,
    lines,
  }
}

/** Serializes with cancellation: both lock the original row before deciding. */
async function lockAuthorizedOriginal(tx: Transaction, tenantId: string, documentId: string) {
  const [row] = await tx`select document.status, document.establishment_id,
      document.linked_origin_id, document.model, binding.access_key
    from fiscal_documents document
    left join fiscal_document_issuance_bindings binding on binding.tenant_id = document.tenant_id
      and binding.document_id = document.id
    where document.tenant_id = ${tenantId} and document.id = ${documentId}
    for update of document`
  // A consumer's return or complement of an NFC-e has no reviewed flow yet.
  if (row?.model === '65')
    throw new LinkedOriginError(
      'KIND_UNSUPPORTED',
      'Returns and complements of an NFC-e model 65 are not supported',
    )
  if (row?.status !== 'authorized' || row.linked_origin_id !== null || !row.access_key)
    throw new LinkedOriginError(
      'REFERENCE_NOT_AUTHORIZED',
      'The original is not an authorized sale',
    )
  return { establishmentId: String(row.establishment_id), accessKey: String(row.access_key) }
}

async function findByKey(tx: Transaction, tenantId: string, key: string) {
  const [row] = await tx`select record.request_digest, origin.id, origin.kind,
      origin.payload_digest, origin.created_at
    from fiscal_linked_origin_idempotency record
    join fiscal_linked_origins origin on origin.tenant_id = record.tenant_id
      and origin.id = record.linked_origin_id
    where record.tenant_id = ${tenantId} and record.idempotency_key = ${key}`
  return row ? { requestDigest: String(row.request_digest), origin: originView(row) } : null
}

async function findBySource(tx: Transaction, tenantId: string, kind: string, sourceId: string) {
  const [row] = await tx`select id, kind, payload_digest, created_at from fiscal_linked_origins
    where tenant_id = ${tenantId} and kind = ${kind} and source_id = ${sourceId}`
  return row ? originView(row) : null
}

function originView(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind) as Frozen['kind'],
    digest: String(row.payload_digest),
    createdAt: new Date(row.created_at as string).toISOString(),
  }
}

function shareOf(line: Line, part: string): string {
  const whole = quantity(line.quantity)
  if (whole === 0n) return '0'
  return ((BigInt(line.lineTotal.amount) * quantity(part) + whole / 2n) / whole).toString()
}

function roundedTotal(scaledQuantity: bigint, unitPriceMinor: bigint): bigint {
  return (scaledQuantity * unitPriceMinor + SCALE / 2n) / SCALE
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right
}
