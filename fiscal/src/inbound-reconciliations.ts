import { randomUUID } from 'node:crypto'
import { type FiscalInboundReconciliation, fiscalInboundMatched } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import { canonicalDigest } from './canonical-json'
import { openInboundSnapshot } from './inbound-crypto'
import { readReconciliation } from './inbound-imports'
import {
  AllocationError,
  type Comparison,
  compareAllocations,
  compareTaxes,
  quantity,
} from './inbound-matching'
import { loadItemMappings, loadOpenReceiptLines } from './inbound-queries'
import type { InboundVerification } from './nfe55/inbound'
import type { FiscalProjections } from './projections'

type Transaction = postgres.TransactionSql

export type InboundReconciliationRequest = {
  supplierPartyId: string
  lines: Array<{ lineNumber: number; receiptId: string; receiptLineId: string; quantity: string }>
  unmatchedLines: number[]
  unitFactors?: Array<{ lineNumber: number; factor: string }>
  rememberMappings: boolean
  overrideReason?: string
}

export type InboundReconciliationErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_RECONCILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SUPPLIER_MISMATCH'
  | 'BLOCKED'
  | 'ALLOCATION_INVALID'
  | 'NO_RECEIPT'
  | 'OVERRIDE_REQUIRED'
  | 'OVERRIDE_NOT_ALLOWED'

export class InboundReconciliationError extends Error {
  constructor(
    readonly code: InboundReconciliationErrorCode,
    message: string,
    readonly comparison: Comparison | null = null,
  ) {
    super(message)
    this.name = 'InboundReconciliationError'
  }
}

/**
 * Commits one reviewed reconciliation per supplier NF-e. The server recomputes the
 * comparison from its own projections, keeps it with the decision, and publishes
 * `fiscal.inbound.matched`; it never creates a receipt, stock movement or payable.
 */
export class FiscalInboundReconciliations {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly projections: Pick<FiscalProjections, 'findPartiesByTaxId'>,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal inbound key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async reconcile(input: {
    tenantId: string
    importId: string
    request: InboundReconciliationRequest
    idempotencyKey: string
    actorId: string
  }): Promise<{ reconciliation: FiscalInboundReconciliation; replayed: boolean }> {
    z.uuid().parse(input.tenantId)
    const requestDigest = canonicalDigest({ importId: input.importId, request: input.request })
    const replay = await this.replay(input, requestDigest)
    if (replay) return { reconciliation: replay, replayed: true }

    const document = await this.document(input.tenantId, input.importId)
    const candidates = await this.projections.findPartiesByTaxId(
      input.tenantId,
      document.issuerTaxId,
    )
    if (!candidates.includes(input.request.supplierPartyId))
      throw new InboundReconciliationError(
        'SUPPLIER_MISMATCH',
        'The chosen supplier does not carry the NF-e issuer tax id',
      )
    try {
      const reconciliation = await this.#db.begin((tx) =>
        this.commit(tx, input, requestDigest, document),
      )
      return { reconciliation, replayed: false }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replayed = await this.replay(input, requestDigest)
        if (replayed) return { reconciliation: replayed, replayed: true }
        throw new InboundReconciliationError(
          'ALREADY_RECONCILED',
          'Supplier NF-e is already reconciled',
        )
      }
      if (isCheckViolation(error, 'conflicting duplicate'))
        throw new InboundReconciliationError('BLOCKED', 'Supplier NF-e has an open conflict')
      if (isCheckViolation(error, 'allocation exceeds'))
        throw new InboundReconciliationError(
          'ALLOCATION_INVALID',
          'Allocation exceeds the quantity still open on the receipt line',
        )
      throw error
    }
  }

  private async commit(
    tx: Transaction,
    input: Parameters<FiscalInboundReconciliations['reconcile']>[0],
    requestDigest: string,
    document: Awaited<ReturnType<FiscalInboundReconciliations['document']>>,
  ): Promise<FiscalInboundReconciliation> {
    const { tenantId, importId, request } = input
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    if (await readReconciliation(tx, tenantId, importId))
      throw new InboundReconciliationError(
        'ALREADY_RECONCILED',
        'Supplier NF-e is already reconciled',
      )
    const [blocking] = await tx`select c.id from fiscal_inbound_conflicts c
      where c.tenant_id = ${tenantId} and c.import_id = ${importId}
        and not exists (select 1 from fiscal_inbound_conflict_dismissals m
          where m.tenant_id = c.tenant_id and m.conflict_id = c.id)`
    if (blocking)
      throw new InboundReconciliationError('BLOCKED', 'Supplier NF-e has an open conflict')

    const keys = request.lines.map(
      (line) => `${line.lineNumber}:${line.receiptId}:${line.receiptLineId}`,
    )
    if (new Set(keys).size !== keys.length)
      throw new InboundReconciliationError(
        'ALLOCATION_INVALID',
        'An invoice line names the same receipt line twice',
      )
    const receiptLines = await loadOpenReceiptLines(tx, tenantId, [request.supplierPartyId], true)
    const mappings = await loadItemMappings(tx, tenantId, request.supplierPartyId)
    const factors = new Map(
      (request.unitFactors ?? []).map((entry) => [entry.lineNumber, entry.factor]),
    )
    let comparison: Comparison
    try {
      comparison = compareAllocations({
        lines: document.invoice.lines,
        allocations: request.lines,
        unmatchedLines: request.unmatchedLines,
        receiptLines,
        mappings,
        factors,
      })
    } catch (error) {
      if (error instanceof AllocationError)
        throw new InboundReconciliationError('ALLOCATION_INVALID', error.message)
      throw error
    }
    const receipts = [
      ...new Map(
        comparison.lines
          .flatMap((line) => line.allocations)
          .map((allocation) => [
            allocation.receiptId,
            { receiptId: allocation.receiptId, orderId: allocation.orderId },
          ]),
      ).values(),
    ]
    if (receipts.length === 0)
      throw new InboundReconciliationError(
        'NO_RECEIPT',
        'A reconciliation must link at least one received line',
      )
    const orderIds = [...new Set(receipts.map((receipt) => receipt.orderId))]
    const [estimate] =
      orderIds.length === 1
        ? await tx`select order_id, components, result_digest from fiscal_purchase_order_estimates
            where tenant_id = ${tenantId} and order_id = ${orderIds[0] ?? ''}`
        : []
    comparison = {
      ...comparison,
      taxes: compareTaxes({
        totals: document.invoice.totals,
        orderIds,
        estimate: estimate
          ? {
              orderId: String(estimate.order_id),
              components: estimate.components as Array<{
                code: string
                amount: { amount: string }
              }>,
              resultDigest: String(estimate.result_digest),
            }
          : null,
      }),
    }
    const reason = request.overrideReason?.trim()
    if (!comparison.clean && !reason)
      throw new InboundReconciliationError(
        'OVERRIDE_REQUIRED',
        'The NF-e differs from what was received; an override reason is required',
        comparison,
      )
    if (comparison.clean && reason)
      throw new InboundReconciliationError(
        'OVERRIDE_NOT_ALLOWED',
        'An override reason is only accepted when the comparison has differences',
        comparison,
      )

    const payables = await tx`select title_id from fiscal_purchase_payables
      where tenant_id = ${tenantId} and reversed_at is null
        and receipt_id in ${tx(receipts.map((receipt) => receipt.receiptId))}
      order by title_id`
    const payableTitleIds = payables.map((row) => String(row.title_id))
    const id = randomUUID()
    const comparisonDigest = canonicalDigest(comparison)
    const [stored] = await tx`insert into fiscal_inbound_reconciliations (
        id, tenant_id, import_id, supplier_party_id, decision, override_reason, comparison,
        comparison_digest, receipts, payable_title_ids, idempotency_key, request_digest, reviewed_by
      ) values (
        ${id}, ${tenantId}, ${importId}, ${request.supplierPartyId},
        ${comparison.clean ? 'matched' : 'overridden'}, ${reason ?? null}, ${tx.json(comparison)},
        ${comparisonDigest}, ${tx.json(receipts)}, ${tx.json(payableTitleIds)},
        ${input.idempotencyKey}, ${requestDigest}, ${input.actorId}
      ) returning reviewed_at`
    for (const allocation of request.lines)
      await tx`insert into fiscal_inbound_reconciliation_lines
        (tenant_id, reconciliation_id, line_number, receipt_id, receipt_line_id, quantity)
        values (${tenantId}, ${id}, ${allocation.lineNumber}, ${allocation.receiptId},
          ${allocation.receiptLineId}, ${allocation.quantity})`
    if (request.rememberMappings) await this.remember(tx, input, id, comparison, mappings, factors)

    const reconciliation = await readReconciliation(tx, tenantId, importId)
    if (!reconciliation || !stored) throw new Error('Supplier NF-e reconciliation was not stored')
    const payload = fiscalInboundMatched.payload.parse({
      importId,
      reconciliationId: id,
      accessKey: document.issuerKind === 'cnpj' ? document.accessKey : null,
      supplierPartyId: request.supplierPartyId,
      decision: reconciliation.decision,
      receipts,
      payableTitleIds,
      authorityEnvironment: document.authorityEnvironment,
      signature: document.verification.signature,
      authorityStatus: document.verification.authorityStatus,
      comparisonDigest,
      reviewedBy: input.actorId,
      observedAt: reconciliation.reviewedAt,
    })
    await tx`insert into fiscal_outbox (tenant_id, event_id, event_type, payload)
      values (${tenantId}, ${randomUUID()}, ${fiscalInboundMatched.type}, ${tx.json(payload)})`
    await appendAudit(tx, {
      tenantId,
      actorId: input.actorId,
      action: 'fiscal.inbound.reconciled',
      resourceId: importId,
      detail: { reconciliationId: id, decision: reconciliation.decision, comparisonDigest, reason },
    })
    return reconciliation
  }

  /** A new mapping version only when the item or the unit factor changed. */
  private async remember(
    tx: Transaction,
    input: Parameters<FiscalInboundReconciliations['reconcile']>[0],
    reconciliationId: string,
    comparison: Comparison,
    mappings: Awaited<ReturnType<typeof loadItemMappings>>,
    factors: ReadonlyMap<number, string>,
  ): Promise<void> {
    for (const line of comparison.lines) {
      const items = new Set(line.allocations.map((allocation) => allocation.itemId))
      if (items.size !== 1) continue
      const itemId = [...items][0] as string
      const current = mappings.find((mapping) => mapping.productCode === line.productCode)
      const factor = factors.get(line.lineNumber) ?? current?.factor ?? '1'
      if (current?.itemId === itemId && quantity(current.factor) === quantity(factor)) continue
      await tx`insert into fiscal_supplier_item_mappings
        (tenant_id, supplier_party_id, product_code, version, item_id, factor, reconciliation_id, created_by)
        select ${input.tenantId}, ${input.request.supplierPartyId}, ${line.productCode},
          coalesce(max(version), 0) + 1, ${itemId}, ${factor}, ${reconciliationId}, ${input.actorId}
        from fiscal_supplier_item_mappings
        where tenant_id = ${input.tenantId} and supplier_party_id = ${input.request.supplierPartyId}
          and product_code = ${line.productCode}`
    }
  }

  private async replay(
    input: { tenantId: string; importId: string; idempotencyKey: string },
    requestDigest: string,
  ): Promise<FiscalInboundReconciliation | null> {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${input.tenantId}, true)`
      const [existing] =
        await tx`select import_id, request_digest from fiscal_inbound_reconciliations
        where tenant_id = ${input.tenantId} and idempotency_key = ${input.idempotencyKey}`
      if (!existing) return null
      if (existing.import_id !== input.importId || existing.request_digest !== requestDigest)
        throw new InboundReconciliationError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used for another reconciliation',
        )
      return readReconciliation(tx, input.tenantId, input.importId)
    })
  }

  private async document(tenantId: string, importId: string) {
    if (!z.uuid().safeParse(importId).success)
      throw new InboundReconciliationError('NOT_FOUND', 'Supplier NF-e import not found')
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select access_key, authority_environment, verification, snapshot
        from fiscal_inbound_documents where tenant_id = ${tenantId} and id = ${importId}`
    })
    if (!row) throw new InboundReconciliationError('NOT_FOUND', 'Supplier NF-e import not found')
    const invoice = openInboundSnapshot(this.masterKey, tenantId, importId, row.snapshot)
    return {
      accessKey: String(row.access_key),
      authorityEnvironment: row.authority_environment as 'production' | 'homologation',
      verification: row.verification as InboundVerification,
      issuerTaxId: invoice.issuer.taxId,
      issuerKind: invoice.issuer.kind,
      invoice,
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505'
}

function isCheckViolation(error: unknown, fragment: string): boolean {
  const candidate = error as { code?: string; message?: string }
  return candidate?.code === '23514' && (candidate.message ?? '').includes(fragment)
}
