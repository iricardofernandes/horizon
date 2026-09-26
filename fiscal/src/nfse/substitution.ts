import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalServiceDocuments, ServiceDraft } from './documents'
import { SubstitutionNotAllowed } from './errors'
import type { ServiceProfile } from './issuance'
import type { FiscalServiceOrigins } from './service-origins'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
  reasonCode: z.enum(['01', '02', '03', '04', '05', '99']),
  reason: z.string().trim().min(15).max(255).nullable(),
  correctedServiceOriginId: z.uuid(),
})

const DAY = 86_400_000

/**
 * Substitution: a new DPS with `subst` whose generation cancels the original (event
 * 105102). A provider outside the Simples Nacional may change only the value and the
 * description: recipient, competence, service code and place stay (E0058, E0060).
 */
export class FiscalServiceSubstitutions {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<FiscalServiceDocuments, 'get' | 'createSubstitute'>,
    private readonly origins: Pick<FiscalServiceOrigins, 'open'>,
    private readonly profile: ServiceProfile,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#db = postgres(databaseUrl, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async request(input: z.input<typeof commandSchema>): Promise<ServiceDraft> {
    const command = commandSchema.parse(input)
    if (command.reasonCode === '99' && !command.reason)
      throw new SubstitutionNotAllowed('Reason code 99 needs a text (E0078)')
    const replay = await this.replay(command)
    if (replay) return replay
    const original = await this.documents.get(command.tenantId, command.documentId)
    if (!original) throw new Error('Fiscal document not found')
    if (original.status !== 'authorized' || !original.generatedAt)
      throw new SubstitutionNotAllowed('Only an authorized NFS-e can be substituted (E0046)')
    if (original.substitutedByDocumentId)
      throw new SubstitutionNotAllowed('The NFS-e was already substituted')
    if (
      this.now().getTime() - Date.parse(original.generatedAt) >
      this.profile.substitutionWindowDays * DAY
    )
      throw new SubstitutionNotAllowed(
        `The municipal substitution window of ${this.profile.substitutionWindowDays} days has elapsed (E0050)`,
      )
    const [previous, corrected, pending] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      return Promise.all([
        this.origins.open(tx, command.tenantId, original.serviceOriginId),
        this.origins.open(tx, command.tenantId, command.correctedServiceOriginId),
        tx`select id from fiscal_documents where tenant_id = ${command.tenantId}
          and (substitutes_document_id = ${command.documentId}
            or service_origin_id = ${command.correctedServiceOriginId})
          and status not in ('rejected', 'cancelled')`,
      ])
    })
    if (pending.length > 0)
      throw new SubstitutionNotAllowed('A substitute or a live document already uses these facts')
    const before = previous.payload
    const after = corrected.payload
    if (after.originId === before.originId)
      throw new SubstitutionNotAllowed('A substitute needs a corrected service origin')
    if (
      after.establishmentId !== before.establishmentId ||
      after.customerId !== before.customerId ||
      after.competenceDate !== before.competenceDate ||
      after.serviceItemId !== before.serviceItemId ||
      after.nationalTaxCode !== before.nationalTaxCode ||
      after.municipalTaxCode !== before.municipalTaxCode ||
      after.municipalityCode !== before.municipalityCode
    )
      throw new SubstitutionNotAllowed(
        'Recipient, competence, service code and place of provision cannot change (E0058, E0060)',
      )
    return this.documents.createSubstitute({
      tenantId: command.tenantId,
      originalDocumentId: command.documentId,
      serviceOriginId: command.correctedServiceOriginId,
      reasonCode: command.reasonCode,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      actorId: command.actorId,
    })
  }

  /** A retried request returns its substitute even after the original was cancelled. */
  private async replay(command: z.infer<typeof commandSchema>): Promise<ServiceDraft | null> {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      return tx`select record.document_id, document.substitutes_document_id,
          document.service_origin_id, document.snapshot_digest
        from fiscal_idempotency record
        join fiscal_documents document on document.tenant_id = record.tenant_id
          and document.id = record.document_id
        where record.tenant_id = ${command.tenantId} and record.key = ${command.idempotencyKey}`
    })
    if (!row) return null
    if (
      row.substitutes_document_id !== command.documentId ||
      row.service_origin_id !== command.correctedServiceOriginId
    )
      throw new Error('Conflicting fiscal idempotency key')
    return {
      id: String(row.document_id),
      status: 'draft',
      snapshotDigest: String(row.snapshot_digest),
      existing: true,
    }
  }
}
