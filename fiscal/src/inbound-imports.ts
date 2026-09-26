import { randomUUID } from 'node:crypto'
import type {
  FiscalInboundImport,
  FiscalInboundImportSummary,
  FiscalInboundReconciliation,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifactStore } from './artifact-store'
import { appendAudit } from './audit'
import { openInboundSnapshot, sealInboundSnapshot } from './inbound-crypto'
import { proposeAllocations } from './inbound-matching'
import { loadItemMappings, loadNcmByItem, loadOpenReceiptLines } from './inbound-queries'
import { InboundRejection, type InboundVerification, verifyInboundNfe55 } from './nfe55/inbound'
import { partyTaxIdDigest } from './party-tax-index'
import type { FiscalProjections } from './projections'

type Sql = ReturnType<typeof postgres>
type Transaction = postgres.TransactionSql
type Status = FiscalInboundImportSummary['status']

export type InboundImportOutcome = {
  outcome: 'created' | 'duplicate' | 'conflict'
  importId: string
  conflictId: string | null
}

const STATUS_SQL = `case
  when exists (select 1 from fiscal_inbound_reconciliations x
    where x.tenant_id = d.tenant_id and x.import_id = d.id) then 'reconciled'
  when exists (select 1 from fiscal_inbound_conflicts c
    where c.tenant_id = d.tenant_id and c.import_id = d.id
      and not exists (select 1 from fiscal_inbound_conflict_dismissals m
        where m.tenant_id = c.tenant_id and m.conflict_id = c.id)) then 'blocked'
  else 'open' end`

/**
 * Supplier NF-e imports. An import verifies and keeps evidence; it never creates stock,
 * a receipt or a payable, which stay with Procurement and Financial.
 */
export class FiscalInboundImports {
  readonly #db: Sql

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly store: FiscalArtifactStore,
    private readonly projections: Pick<FiscalProjections, 'resolveIssuer' | 'findPartiesByTaxId'>,
    private readonly schema: { zip: Buffer; digest: string },
    private readonly today: () => string = brazilToday,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal inbound key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async import(input: {
    tenantId: string
    xml: Buffer
    actorId: string
  }): Promise<InboundImportOutcome> {
    z.uuid().parse(input.tenantId)
    const issuer = await this.projections.resolveIssuer(input.tenantId, this.today())
    if (!issuer?.company.taxId)
      throw new InboundRejection('RECIPIENT_MISMATCH', 'The company issuer profile is unavailable')
    const { invoice, verification } = await verifyInboundNfe55({
      xml: input.xml,
      recipientTaxId: issuer.company.taxId,
      schemaZip: this.schema.zip,
      expectedZipDigest: this.schema.digest,
    })
    const importId = randomUUID()
    const objectKey = `${input.tenantId}/${importId}/inbound_xml/${verification.sourceDigest}`
    const existing = await this.findByKey(input.tenantId, invoice.accessKey)
    if (!existing) {
      await this.store.put(objectKey, input.xml)
      const created = await this.#db.begin(async (tx) => {
        await scope(tx, input.tenantId)
        const inserted = await tx`insert into fiscal_inbound_documents (
            id, tenant_id, access_key, series, number, issued_at, authority_environment,
            issuer_tax_digest, invoice_total_minor, line_count, source_digest, content_digest,
            object_key, verification, snapshot, imported_by
          ) values (
            ${importId}, ${input.tenantId}, ${invoice.accessKey}, ${invoice.series},
            ${invoice.number}, ${invoice.issuedAt}, ${invoice.environment},
            ${partyTaxIdDigest(this.masterKey, input.tenantId, invoice.issuer.taxId)},
            ${minor(invoice.totals.invoice)}, ${invoice.lines.length}, ${verification.sourceDigest},
            ${verification.contentDigest}, ${objectKey}, ${tx.json(verification)},
            ${sealInboundSnapshot(this.masterKey, input.tenantId, importId, invoice)}, ${input.actorId}
          ) on conflict on constraint fiscal_inbound_document_key do nothing returning id`
        if (inserted.length === 0) return false
        await appendAudit(tx, {
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'fiscal.inbound.imported',
          resourceId: importId,
          detail: { accessKey: invoice.accessKey, sourceDigest: verification.sourceDigest },
        })
        return true
      })
      if (created) return { outcome: 'created', importId, conflictId: null }
    }
    const original = existing ?? (await this.findByKey(input.tenantId, invoice.accessKey))
    if (!original) throw new Error('Supplier NF-e import disappeared during deduplication')
    if (original.contentDigest === verification.contentDigest)
      return { outcome: 'duplicate', importId: original.id, conflictId: null }
    return this.recordConflict(input, original.id, verification)
  }

  async list(
    tenantId: string,
    query: { status?: Status; cursor?: string; limit: number },
  ): Promise<{
    data: FiscalInboundImportSummary[]
    page: { hasMore: boolean; nextCursor?: string }
  }> {
    z.uuid().parse(tenantId)
    const after = query.cursor ? decodeCursor(query.cursor) : null
    const rows = await this.#db.begin(async (tx) => {
      await scope(tx, tenantId)
      return tx`select * from (
          select d.*, ${tx.unsafe(STATUS_SQL)} as status from fiscal_inbound_documents d
          where d.tenant_id = ${tenantId}
        ) d
        where (${query.status ?? null}::text is null or d.status = ${query.status ?? null})
          and (${after?.createdAt ?? null}::timestamptz is null
            or (d.imported_at, d.id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
        order by d.imported_at, d.id limit ${query.limit + 1}`
    })
    const page = rows.slice(0, query.limit)
    const summaries = await Promise.all(page.map((row) => this.summary(tenantId, row)))
    const last = page.at(-1)
    return {
      data: summaries,
      page:
        rows.length > query.limit && last
          ? {
              hasMore: true,
              nextCursor: encodeCursor(instant(last.imported_at), String(last.id)),
            }
          : { hasMore: false },
    }
  }

  async get(tenantId: string, importId: string): Promise<FiscalInboundImport | null> {
    z.uuid().parse(tenantId)
    if (!z.uuid().safeParse(importId).success) return null
    const row = await this.row(tenantId, importId)
    if (!row) return null
    const invoice = openInboundSnapshot(this.masterKey, tenantId, importId, row.snapshot)
    const candidates = await this.projections.findPartiesByTaxId(tenantId, invoice.issuer.taxId)
    return this.#db.begin(async (tx) => {
      await scope(tx, tenantId)
      const conflicts = await tx`select c.id, c.source_digest, c.content_digest, c.received_at,
          m.reason from fiscal_inbound_conflicts c
        left join fiscal_inbound_conflict_dismissals m
          on m.tenant_id = c.tenant_id and m.conflict_id = c.id
        where c.tenant_id = ${tenantId} and c.import_id = ${importId}
        order by c.received_at, c.id`
      const reconciliation = await readReconciliation(tx, tenantId, importId)
      const proposals = reconciliation
        ? []
        : await proposalsFor(tx, tenantId, candidates, invoice.lines)
      return {
        ...(await this.summary(tenantId, row, candidates)),
        verification: row.verification as InboundVerification,
        supplier: {
          taxId: invoice.issuer.taxId,
          kind: invoice.issuer.kind,
          legalName: invoice.issuer.legalName,
          uf: invoice.issuer.uf,
          candidatePartyIds: candidates,
        },
        lines: invoice.lines,
        conflicts: conflicts.map((conflict) => ({
          id: String(conflict.id),
          sourceDigest: String(conflict.source_digest),
          contentDigest: String(conflict.content_digest),
          receivedAt: instant(conflict.received_at),
          dismissed: conflict.reason !== null,
          dismissalReason: conflict.reason === null ? null : String(conflict.reason),
        })),
        proposals,
        reconciliation,
        laterChanges: reconciliation ? await laterChanges(tx, tenantId, reconciliation) : [],
      }
    })
  }

  async xml(tenantId: string, importId: string): Promise<{ bytes: Buffer; digest: string } | null> {
    z.uuid().parse(tenantId)
    if (!z.uuid().safeParse(importId).success) return null
    const row = await this.row(tenantId, importId)
    if (!row) return null
    const bytes = await this.store.get(String(row.object_key))
    return { bytes, digest: String(row.source_digest) }
  }

  async dismissConflict(input: {
    tenantId: string
    importId: string
    conflictId: string
    reason: string
    actorId: string
  }): Promise<'dismissed' | 'already-dismissed'> {
    z.uuid().parse(input.tenantId)
    return this.#db.begin(async (tx) => {
      await scope(tx, input.tenantId)
      const [conflict] = await tx`select id from fiscal_inbound_conflicts
        where tenant_id = ${input.tenantId} and import_id = ${input.importId} and id = ${input.conflictId}`
      if (!conflict) throw new Error('Supplier NF-e conflict not found')
      const inserted = await tx`insert into fiscal_inbound_conflict_dismissals
        (tenant_id, conflict_id, reason, dismissed_by)
        values (${input.tenantId}, ${input.conflictId}, ${input.reason.trim()}, ${input.actorId})
        on conflict do nothing returning conflict_id`
      if (inserted.length === 0) return 'already-dismissed'
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'fiscal.inbound.conflict-dismissed',
        resourceId: input.importId,
        detail: { conflictId: input.conflictId, reason: input.reason.trim() },
      })
      return 'dismissed'
    })
  }

  private async recordConflict(
    input: { tenantId: string; xml: Buffer; actorId: string },
    originalId: string,
    verification: InboundVerification,
  ): Promise<InboundImportOutcome> {
    const objectKey = `${input.tenantId}/${originalId}/inbound_conflict_xml/${verification.sourceDigest}`
    await this.store.put(objectKey, input.xml)
    return this.#db.begin(async (tx) => {
      await scope(tx, input.tenantId)
      const conflictId = randomUUID()
      await tx`insert into fiscal_inbound_conflicts
        (id, tenant_id, import_id, source_digest, content_digest, object_key, received_by)
        values (${conflictId}, ${input.tenantId}, ${originalId}, ${verification.sourceDigest},
          ${verification.contentDigest}, ${objectKey}, ${input.actorId})
        on conflict on constraint fiscal_inbound_conflict_bytes do nothing`
      const [stored] = await tx`select id from fiscal_inbound_conflicts
        where tenant_id = ${input.tenantId} and import_id = ${originalId}
          and source_digest = ${verification.sourceDigest}`
      if (!stored) throw new Error('Supplier NF-e conflict was not recorded')
      if (String(stored.id) === conflictId)
        await appendAudit(tx, {
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'fiscal.inbound.conflict-recorded',
          resourceId: originalId,
          detail: { sourceDigest: verification.sourceDigest },
        })
      return { outcome: 'conflict', importId: originalId, conflictId: String(stored.id) }
    })
  }

  private async findByKey(
    tenantId: string,
    accessKey: string,
  ): Promise<{ id: string; contentDigest: string } | null> {
    const [row] = await this.#db.begin(async (tx) => {
      await scope(tx, tenantId)
      return tx`select id, content_digest from fiscal_inbound_documents
        where tenant_id = ${tenantId} and access_key = ${accessKey}`
    })
    return row ? { id: String(row.id), contentDigest: String(row.content_digest) } : null
  }

  private async row(tenantId: string, importId: string): Promise<postgres.Row | null> {
    const [row] = await this.#db.begin(async (tx) => {
      await scope(tx, tenantId)
      return tx`select d.*, ${tx.unsafe(STATUS_SQL)} as status from fiscal_inbound_documents d
        where d.tenant_id = ${tenantId} and d.id = ${importId}`
    })
    return row ?? null
  }

  private async summary(
    tenantId: string,
    row: postgres.Row,
    knownCandidates?: string[],
  ): Promise<FiscalInboundImportSummary> {
    const reconciledSupplier = await this.#db.begin(async (tx) => {
      await scope(tx, tenantId)
      const [reconciled] = await tx`select supplier_party_id from fiscal_inbound_reconciliations
        where tenant_id = ${tenantId} and import_id = ${row.id}`
      if (reconciled) return String(reconciled.supplier_party_id)
      if (knownCandidates) return null
      const candidates = await tx`select party_id from fiscal_party_tax_index
        where tenant_id = ${tenantId} and tax_id_digest = ${row.issuer_tax_digest}`
      return candidates.length === 1 ? String(candidates[0]?.party_id) : null
    })
    const supplierPartyId =
      reconciledSupplier ??
      (knownCandidates && knownCandidates.length === 1 ? (knownCandidates[0] ?? null) : null)
    return {
      id: String(row.id),
      accessKey: String(row.access_key),
      series: Number(row.series),
      number: Number(row.number),
      issuedAt: String(row.issued_at),
      authorityEnvironment: row.authority_environment as 'production' | 'homologation',
      supplierPartyId,
      invoiceTotal: decimal(String(row.invoice_total_minor)),
      lineCount: Number(row.line_count),
      status: row.status as Status,
      importedAt: instant(row.imported_at),
    }
  }
}

async function proposalsFor(
  tx: Transaction,
  tenantId: string,
  candidates: string[],
  lines: FiscalInboundImport['lines'],
): Promise<FiscalInboundImport['proposals']> {
  const open = await loadOpenReceiptLines(tx, tenantId, candidates)
  const mappings =
    candidates.length === 1 ? await loadItemMappings(tx, tenantId, candidates[0] as string) : []
  const ncmByItem = await loadNcmByItem(
    tx,
    tenantId,
    open.map((line) => line.itemId),
  )
  return proposeAllocations({ lines, receiptLines: open, mappings, ncmByItem })
}

export async function readReconciliation(
  tx: Transaction,
  tenantId: string,
  importId: string,
): Promise<FiscalInboundReconciliation | null> {
  const [row] = await tx`select * from fiscal_inbound_reconciliations
    where tenant_id = ${tenantId} and import_id = ${importId}`
  if (!row) return null
  return {
    id: String(row.id),
    importId: String(row.import_id),
    decision: row.decision as 'matched' | 'overridden',
    supplierPartyId: String(row.supplier_party_id),
    overrideReason: row.override_reason === null ? null : String(row.override_reason),
    comparison: row.comparison as FiscalInboundReconciliation['comparison'],
    comparisonDigest: String(row.comparison_digest),
    receipts: row.receipts as FiscalInboundReconciliation['receipts'],
    payableTitleIds: row.payable_title_ids as string[],
    reviewedBy: String(row.reviewed_by),
    reviewedAt: instant(row.reviewed_at),
  }
}

/** Returns and reversals after the decision; they are shown, never folded into it. */
async function laterChanges(
  tx: Transaction,
  tenantId: string,
  reconciliation: FiscalInboundReconciliation,
): Promise<FiscalInboundImport['laterChanges']> {
  const receiptIds = reconciliation.receipts.map((receipt) => receipt.receiptId)
  const returned = await tx`select receipt_id, returned_at from fiscal_purchase_receipts
    where tenant_id = ${tenantId} and receipt_id in ${tx(receiptIds)}
      and returned_at > ${reconciliation.reviewedAt}`
  const reversed = await tx`select title_id, reversed_at from fiscal_purchase_payables
    where tenant_id = ${tenantId} and receipt_id in ${tx(receiptIds)}
      and reversed_at > ${reconciliation.reviewedAt}`
  return [
    ...returned.map((row) => ({
      kind: 'receipt-returned' as const,
      subjectId: String(row.receipt_id),
      observedAt: instant(row.returned_at),
    })),
    ...reversed.map((row) => ({
      kind: 'payable-reversed' as const,
      subjectId: String(row.title_id),
      observedAt: instant(row.reversed_at),
    })),
  ]
}

async function scope(tx: Transaction, tenantId: string): Promise<void> {
  await tx`select set_config('app.current_tenant', ${tenantId}, true)`
}

export function brazilToday(): string {
  return new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10)
}

export function minor(value: string): string {
  const match = /^(\d{1,13})\.(\d{2})$/.exec(value)
  if (!match) throw new InboundRejection('UNSUPPORTED_DOCUMENT', 'Invoice total is malformed')
  return (BigInt(match[1] ?? '0') * 100n + BigInt(match[2] ?? '0')).toString()
}

function decimal(minorUnits: string): string {
  const value = BigInt(minorUnits)
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

export function instant(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString()
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
    throw new SyntaxError('Invalid Fiscal import cursor')
  }
}
