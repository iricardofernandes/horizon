import { createHash, randomUUID } from 'node:crypto'
import { type FiscalServiceDocument, fiscalServiceDocumentSchema } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from '../audit'
import { canonicalDigest } from '../canonical-json'
import { encryptSnapshot } from '../documents'
import type { FiscalServiceOrigins, ServiceOriginPayload } from './service-origins'
import { isoDate } from './service-profiles'

const draftSchema = z.strictObject({
  tenantId: z.uuid(),
  serviceOriginId: z.uuid(),
  establishmentId: z.uuid(),
  series: z.number().int().min(1).max(999),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
})

export type ServiceDraft = {
  id: string
  status: 'draft'
  snapshotDigest: string
  existing: boolean
}

/** NFS-e documents: drafts from service origins, substitutes, and their read model. */
export class FiscalServiceDocuments {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly origins: Pick<FiscalServiceOrigins, 'open'>,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal document key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async createDraft(input: z.input<typeof draftSchema>): Promise<ServiceDraft> {
    const value = draftSchema.parse(input)
    const requestDigest = canonicalDigest({
      serviceOriginId: value.serviceOriginId,
      establishmentId: value.establishmentId,
      series: value.series,
      model: 'nfse',
      environment: 'simulation',
    })
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${value.tenantId}:${value.serviceOriginId}`}, 0))`
      const { plaintext, digest, payload } = await this.origins.open(
        tx,
        value.tenantId,
        value.serviceOriginId,
      )
      if (payload.establishmentId !== value.establishmentId)
        throw new Error('Fiscal service-origin establishment mismatch')
      const prior = await priorKey(tx, value.tenantId, value.idempotencyKey, requestDigest)
      if (prior) return { id: prior, status: 'draft', snapshotDigest: digest, existing: true }
      const [existing] = await tx`select id, establishment_id, series, snapshot_digest, status
        from fiscal_documents where tenant_id = ${value.tenantId}
          and service_origin_id = ${value.serviceOriginId}
        order by created_at desc limit 1`
      let documentId: string
      let reused = false
      if (existing && !['rejected', 'cancelled'].includes(String(existing.status))) {
        if (
          existing.establishment_id !== value.establishmentId ||
          Number(existing.series) !== value.series ||
          existing.snapshot_digest !== digest
        )
          throw new Error('Conflicting fiscal service-origin draft')
        documentId = String(existing.id)
        reused = true
      } else if (existing) {
        throw new Error('Conflicting fiscal service origin requires a corrected origin')
      } else {
        documentId = await insertDocument(tx, this.masterKey, {
          tenantId: value.tenantId,
          establishmentId: value.establishmentId,
          series: value.series,
          plaintext,
          digest,
          payload,
          substitutesDocumentId: null,
        })
        await appendAudit(tx, {
          tenantId: value.tenantId,
          actorId: value.actorId,
          action: 'document.service-draft-created',
          resourceId: documentId,
          detail: { serviceOriginId: value.serviceOriginId, digest },
        })
      }
      await tx`insert into fiscal_idempotency (
          tenant_id, key, command, request_digest, document_id
        ) values (
          ${value.tenantId}, ${value.idempotencyKey}, 'document.create-service',
          ${requestDigest}, ${documentId}
        )`
      return { id: documentId, status: 'draft', snapshotDigest: digest, existing: reused }
    })
  }

  /**
   * A substitute NFS-e for an authorized original, from a corrected service origin. The
   * caller has already checked the substitution rules; the database checks them again.
   */
  async createSubstitute(input: {
    tenantId: string
    originalDocumentId: string
    serviceOriginId: string
    reasonCode: '01' | '02' | '03' | '04' | '05' | '99'
    reason: string | null
    idempotencyKey: string
    actorId: string
  }): Promise<ServiceDraft> {
    const requestDigest = canonicalDigest({
      originalDocumentId: input.originalDocumentId,
      serviceOriginId: input.serviceOriginId,
      reasonCode: input.reasonCode,
      reason: input.reason,
    })
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${input.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${input.tenantId}:nfse-substitution:${input.originalDocumentId}`}, 0))`
      const prior = await priorKey(tx, input.tenantId, input.idempotencyKey, requestDigest)
      const { plaintext, digest, payload } = await this.origins.open(
        tx,
        input.tenantId,
        input.serviceOriginId,
      )
      if (prior) return { id: prior, status: 'draft', snapshotDigest: digest, existing: true }
      const [original] = await tx`select establishment_id, series from fiscal_documents
        where tenant_id = ${input.tenantId} and id = ${input.originalDocumentId} for update`
      if (!original) throw new Error('Fiscal document not found')
      const documentId = await insertDocument(tx, this.masterKey, {
        tenantId: input.tenantId,
        establishmentId: String(original.establishment_id),
        series: Number(original.series),
        plaintext,
        digest,
        payload,
        substitutesDocumentId: input.originalDocumentId,
      })
      await tx`insert into fiscal_nfse_substitution_requests (
          tenant_id, substitute_document_id, original_document_id, reason_code, reason, actor_id
        ) values (
          ${input.tenantId}, ${documentId}, ${input.originalDocumentId}, ${input.reasonCode},
          ${input.reason}, ${input.actorId}
        )`
      await tx`insert into fiscal_idempotency (
          tenant_id, key, command, request_digest, document_id
        ) values (
          ${input.tenantId}, ${input.idempotencyKey}, 'document.substitute-service',
          ${requestDigest}, ${documentId}
        )`
      await appendAudit(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        action: 'document.service-substitute-created',
        resourceId: documentId,
        detail: {
          originalDocumentId: input.originalDocumentId,
          serviceOriginId: input.serviceOriginId,
          reasonCode: input.reasonCode,
          digest,
        },
      })
      return { id: documentId, status: 'draft', snapshotDigest: digest, existing: false }
    })
  }

  async get(tenantId: string, documentId: string): Promise<FiscalServiceDocument | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select document.id, document.root_document_id, document.predecessor_document_id,
          document.revision, document.service_origin_id, document.substitutes_document_id,
          document.status, document.model, document.environment, document.establishment_id,
          document.series, document.snapshot_digest, document.created_at,
          origin.municipality_code, origin.competence_date::text as competence_date,
          reservation.number, binding.access_key as dps_id, binding.signed_xml_digest,
          generation.nfse_key, generation.nfse_number, generation.processed_at,
          calculation.result_digest, capability.adapter_version,
          substitution.substitute_document_id as substituted_by
        from fiscal_documents document
        join fiscal_service_origins origin on origin.tenant_id = document.tenant_id
          and origin.id = document.service_origin_id
        left join fiscal_number_reservations reservation
          on reservation.tenant_id = document.tenant_id and reservation.document_id = document.id
        left join fiscal_document_issuance_bindings binding
          on binding.tenant_id = document.tenant_id and binding.document_id = document.id
        left join fiscal_capability_definitions capability
          on capability.tenant_id = binding.tenant_id and capability.id = binding.capability_id
        left join fiscal_nfse_generations generation
          on generation.tenant_id = document.tenant_id and generation.document_id = document.id
        left join fiscal_document_calculation_bindings calculation_binding
          on calculation_binding.tenant_id = document.tenant_id
          and calculation_binding.document_id = document.id
        left join fiscal_calculations calculation
          on calculation.tenant_id = calculation_binding.tenant_id
          and calculation.id = calculation_binding.calculation_id
        left join fiscal_nfse_substitutions substitution
          on substitution.tenant_id = document.tenant_id
          and substitution.original_document_id = document.id
        where document.tenant_id = ${tenantId} and document.id = ${documentId}
          and document.model = 'nfse'`
    })
    if (!row) return null
    return fiscalServiceDocumentSchema.parse({
      id: String(row.id),
      rootDocumentId: String(row.root_document_id),
      predecessorDocumentId:
        row.predecessor_document_id === null ? null : String(row.predecessor_document_id),
      revision: Number(row.revision),
      serviceOriginId: String(row.service_origin_id),
      substitutesDocumentId:
        row.substitutes_document_id === null ? null : String(row.substitutes_document_id),
      substitutedByDocumentId: row.substituted_by === null ? null : String(row.substituted_by),
      status: String(row.status),
      model: 'nfse',
      environment: String(row.environment),
      simulated: true,
      fiscalValue: false,
      establishmentId: String(row.establishment_id),
      municipalityCode: String(row.municipality_code),
      competenceDate: isoDate(row.competence_date),
      series: Number(row.series),
      number: row.number === null ? null : Number(row.number),
      dpsId: row.dps_id === null ? null : String(row.dps_id),
      nfseKey: row.nfse_key === null ? null : String(row.nfse_key),
      nfseNumber: row.nfse_number === null ? null : String(row.nfse_number),
      generatedAt: row.processed_at === null ? null : new Date(row.processed_at).toISOString(),
      snapshotDigest: String(row.snapshot_digest),
      calculationDigest: row.result_digest === null ? null : String(row.result_digest),
      dpsXmlDigest: row.signed_xml_digest === null ? null : String(row.signed_xml_digest),
      adapterVersion: row.adapter_version === null ? null : String(row.adapter_version),
      statusUrl: `/fiscal/service-documents/${row.id}`,
      createdAt: new Date(row.created_at).toISOString(),
    })
  }
}

async function priorKey(
  tx: postgres.TransactionSql,
  tenantId: string,
  idempotencyKey: string,
  requestDigest: string,
): Promise<string | null> {
  const [prior] = await tx`select request_digest, document_id from fiscal_idempotency
    where tenant_id = ${tenantId} and key = ${idempotencyKey}`
  if (!prior) return null
  if (prior.request_digest !== requestDigest) throw new Error('Conflicting fiscal idempotency key')
  return String(prior.document_id)
}

async function insertDocument(
  tx: postgres.TransactionSql,
  masterKey: Buffer,
  input: {
    tenantId: string
    establishmentId: string
    series: number
    plaintext: string
    digest: string
    payload: ServiceOriginPayload
    substitutesDocumentId: string | null
  },
): Promise<string> {
  const id = randomUUID()
  await tx`insert into fiscal_documents (
      id, tenant_id, service_origin_id, substitutes_document_id, model, environment,
      establishment_id, series, snapshot_digest, snapshot_ciphertext
    ) values (
      ${id}, ${input.tenantId}, ${input.payload.originId}, ${input.substitutesDocumentId},
      'nfse', 'simulation', ${input.establishmentId}, ${input.series}, ${input.digest},
      ${encryptSnapshot(masterKey, input.tenantId, id, input.plaintext)}
    )`
  await tx`insert into fiscal_document_lines (tenant_id, document_id, line_index, item_id, line_digest)
    values (${input.tenantId}, ${id}, 0, ${input.payload.serviceItemId},
      ${createHash('sha256').update(input.payload.lineId).digest('hex')})`
  await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
    values (${randomUUID()}, ${input.tenantId}, ${id}, 'draft_created',
      ${JSON.stringify(
        input.substitutesDocumentId ? { substitutesDocumentId: input.substitutesDocumentId } : {},
      )}::jsonb)`
  return id
}
