import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { salesFiscalOriginRecorded } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import { openOrigin } from './origin-crypto'

const draftInputSchema = z.object({
  tenantId: z.uuid(),
  intentId: z.uuid(),
  model: z.enum(['55', '65', 'nfse']),
  environment: z.literal('simulation'),
  establishmentId: z.uuid(),
  series: z.int().min(0).max(999),
  idempotencyKey: z.string().min(16).max(128).optional(),
  actorId: z.string().min(1).max(200).optional(),
})

export type DraftInput = z.infer<typeof draftInputSchema>
export type Draft = { id: string; status: 'draft'; snapshotDigest: string }
export type CorrectedDraft = Draft & {
  rootDocumentId: string
  predecessorDocumentId: string
  revision: number
  existing: boolean
}
export type DocumentView = Omit<Draft, 'status'> & {
  status:
    | 'draft'
    | 'ready'
    | 'queued'
    | 'submitted'
    | 'unknown'
    | 'authorized'
    | 'rejected'
    | 'cancellation_pending'
    | 'cancellation_unknown'
    | 'cancelled'
  simulated: true
  model: '55' | '65' | 'nfse'
  environment: 'simulation'
  establishmentId: string
  series: number
  number: number | null
  rootDocumentId: string
  predecessorDocumentId: string | null
  revision: number
  origin: { kind: 'sales'; intentId: string } | { kind: 'manual'; manualOriginId: string }
  accessKey: string | null
  calculationDigest: string | null
  signedXmlDigest: string | null
  adapterVersion: string | null
  schemaPackageDigest: string | null
  statusUrl: string
  createdAt: string
}

/** Internal Phase 40 persistence. Public issuance remains unavailable. */
export class FiscalDocuments {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    url: string,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal document key must be 32 bytes')
    this.#db = postgres(url, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async get(tenantId: string, documentId: string): Promise<DocumentView | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select d.id, d.status, d.model, d.environment, d.establishment_id,
        d.series, d.snapshot_digest, d.created_at, d.root_document_id,
        d.predecessor_document_id, d.revision, d.intent_id, d.manual_origin_id, r.number,
        issuance.access_key, issuance.signed_xml_digest, calculation.result_digest,
        capability.adapter_version, capability.schema_package_digest
        from fiscal_documents d left join fiscal_number_reservations r
          on r.tenant_id = d.tenant_id and r.document_id = d.id
        left join fiscal_document_issuance_bindings issuance
          on issuance.tenant_id = d.tenant_id and issuance.document_id = d.id
        left join fiscal_capability_definitions capability
          on capability.tenant_id = issuance.tenant_id and capability.id = issuance.capability_id
        left join fiscal_document_calculation_bindings calculation_binding
          on calculation_binding.tenant_id = d.tenant_id
          and calculation_binding.document_id = d.id
        left join fiscal_calculations calculation
          on calculation.tenant_id = calculation_binding.tenant_id
          and calculation.id = calculation_binding.calculation_id
        where d.tenant_id = ${tenantId} and d.id = ${documentId}`
    })
    if (!row) return null
    return {
      id: String(row.id),
      status: row.status as DocumentView['status'],
      simulated: true,
      snapshotDigest: String(row.snapshot_digest),
      model: row.model as DocumentView['model'],
      environment: 'simulation',
      establishmentId: String(row.establishment_id),
      series: Number(row.series),
      number: row.number === null ? null : Number(row.number),
      rootDocumentId: String(row.root_document_id),
      predecessorDocumentId:
        row.predecessor_document_id === null ? null : String(row.predecessor_document_id),
      revision: Number(row.revision),
      origin: row.intent_id
        ? { kind: 'sales', intentId: String(row.intent_id) }
        : { kind: 'manual', manualOriginId: String(row.manual_origin_id) },
      accessKey: row.access_key === null ? null : String(row.access_key),
      calculationDigest: row.result_digest === null ? null : String(row.result_digest),
      signedXmlDigest: row.signed_xml_digest === null ? null : String(row.signed_xml_digest),
      adapterVersion: row.adapter_version === null ? null : String(row.adapter_version),
      schemaPackageDigest:
        row.schema_package_digest === null ? null : String(row.schema_package_digest),
      statusUrl: `/fiscal/documents/${row.id}`,
      createdAt: new Date(row.created_at).toISOString(),
    }
  }

  async createDraft(input: DraftInput): Promise<Draft> {
    const value = draftInputSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [origin] = await tx`select p.payload_ciphertext, p.payload_digest,
        i.payload_digest as intent_digest
        from fiscal_intents i join fiscal_origin_payloads p
          on p.tenant_id = i.tenant_id and p.intent_id = i.id
        where i.tenant_id = ${value.tenantId} and i.id = ${value.intentId}`
      if (!origin) throw new Error('Fiscal origin snapshot unavailable; replay owner event')
      const snapshot = openOrigin(
        this.masterKey,
        value.tenantId,
        value.intentId,
        Buffer.from(origin.payload_ciphertext),
      )
      const digest = createHash('sha256').update(snapshot).digest('hex')
      if (digest !== origin.payload_digest || digest !== origin.intent_digest)
        throw new Error('Fiscal origin snapshot digest mismatch')
      const payload = salesFiscalOriginRecorded.payload.parse(JSON.parse(snapshot))
      const lines = payload.lines
      const requestDigest = createHash('sha256')
        .update(JSON.stringify({ ...value, idempotencyKey: undefined, originDigest: digest }))
        .digest('hex')
      if (value.idempotencyKey) {
        const [prior] = await tx`select request_digest, document_id from fiscal_idempotency
          where tenant_id = ${value.tenantId} and key = ${value.idempotencyKey}`
        if (prior) {
          if (prior.request_digest !== requestDigest)
            throw new Error('Conflicting fiscal idempotency key')
          return { id: String(prior.document_id), status: 'draft' as const, snapshotDigest: digest }
        }
      }
      const id = randomUUID()
      const ciphertext = encryptSnapshot(this.masterKey, value.tenantId, id, snapshot)
      const inserted = await tx`
        insert into fiscal_documents (
          id, tenant_id, intent_id, model, environment, establishment_id, series,
          snapshot_digest, snapshot_ciphertext
        ) values (
          ${id}, ${value.tenantId}, ${value.intentId}, ${value.model},
          ${value.environment}, ${value.establishmentId}, ${value.series}, ${digest}, ${ciphertext}
        ) on conflict do nothing returning id`
      let resultId: string = id
      if (inserted.length > 0) {
        for (const [lineIndex, line] of lines.entries()) {
          const lineDigest = createHash('sha256').update(JSON.stringify(line)).digest('hex')
          await tx`insert into fiscal_document_lines
            (tenant_id, document_id, line_index, item_id, line_digest)
            values (${value.tenantId}, ${id}, ${lineIndex}, ${line.itemId ?? null}, ${lineDigest})`
        }
        await tx`insert into fiscal_transitions
          (id, tenant_id, document_id, kind) values
          (${randomUUID()}, ${value.tenantId}, ${id}, 'draft_created')`
        await appendAudit(tx, {
          tenantId: value.tenantId,
          actorId: value.actorId ?? 'system:fiscal',
          action: 'document.draft-created',
          resourceId: id,
          detail: { intentId: value.intentId, digest },
        })
      } else {
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
        resultId = String(existing.id)
      }
      if (value.idempotencyKey) {
        await tx`insert into fiscal_idempotency
          (tenant_id, key, command, request_digest, document_id)
          values (${value.tenantId}, ${value.idempotencyKey}, 'document.create',
            ${requestDigest}, ${resultId}) on conflict do nothing`
        const [recorded] = await tx`select request_digest, document_id from fiscal_idempotency
          where tenant_id = ${value.tenantId} and key = ${value.idempotencyKey}`
        if (recorded?.request_digest !== requestDigest || recorded?.document_id !== resultId)
          throw new Error('Conflicting fiscal idempotency key')
      }
      return { id: resultId, status: 'draft' as const, snapshotDigest: digest }
    })
  }

  async readSnapshot(tenantId: string, documentId: string): Promise<unknown> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select snapshot_ciphertext, snapshot_digest from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
    })
    if (!row?.snapshot_ciphertext) throw new Error('Fiscal snapshot not found')
    const plaintext = decryptSnapshot(
      this.masterKey,
      tenantId,
      documentId,
      Buffer.from(row.snapshot_ciphertext),
    )
    if (createHash('sha256').update(plaintext).digest('hex') !== row.snapshot_digest)
      throw new Error('Fiscal snapshot digest mismatch')
    return JSON.parse(plaintext)
  }

  async createSuccessor(input: {
    tenantId: string
    documentId: string
    correctedIntentId: string
    idempotencyKey: string
    actorId: string
    reason: string
  }): Promise<CorrectedDraft> {
    const value = z
      .object({
        tenantId: z.uuid(),
        documentId: z.uuid(),
        correctedIntentId: z.uuid(),
        idempotencyKey: z.string().min(16).max(128),
        actorId: z.string().min(1).max(200),
        reason: z.string().trim().min(10).max(1000),
      })
      .parse(input)
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          documentId: value.documentId,
          correctedIntentId: value.correctedIntentId,
          reason: value.reason,
        }),
      )
      .digest('hex')
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [priorKey] = await tx`select request_digest, document_id from fiscal_idempotency
        where tenant_id = ${value.tenantId} and key = ${value.idempotencyKey}`
      if (priorKey) {
        if (priorKey.request_digest !== requestDigest)
          throw new Error('Conflicting fiscal idempotency key')
        const [existing] = await tx`select id, root_document_id, predecessor_document_id,
          revision, snapshot_digest from fiscal_documents
          where tenant_id = ${value.tenantId} and id = ${priorKey.document_id}`
        if (!existing || existing.predecessor_document_id !== value.documentId)
          throw new Error('Conflicting fiscal correction idempotency key')
        return correctedDraft(existing, true)
      }

      const [predecessor] = await tx`select status, root_document_id, revision, model,
          environment, establishment_id, series
        from fiscal_documents where tenant_id = ${value.tenantId}
          and id = ${value.documentId} for update`
      if (!predecessor) throw new Error('Fiscal document not found')
      if (predecessor.status !== 'rejected')
        throw new Error('Only a rejected Fiscal document can be corrected')
      if (predecessor.model !== '55' || predecessor.environment !== 'simulation')
        throw new Error('Fiscal correction is supported only for simulated model 55')
      const [priorSuccessor] = await tx`select id, root_document_id, predecessor_document_id,
          revision, snapshot_digest, intent_id from fiscal_documents
        where tenant_id = ${value.tenantId} and predecessor_document_id = ${value.documentId}`
      if (priorSuccessor) {
        if (priorSuccessor.intent_id !== value.correctedIntentId)
          throw new Error('Fiscal document already has a different successor')
        await tx`insert into fiscal_idempotency
          (tenant_id, key, command, request_digest, document_id)
          values (${value.tenantId}, ${value.idempotencyKey}, 'document.correct',
            ${requestDigest}, ${priorSuccessor.id})`
        return correctedDraft(priorSuccessor, true)
      }
      const [origin] = await tx`select p.payload_ciphertext, p.payload_digest,
          i.payload_digest as intent_digest
        from fiscal_intents i join fiscal_origin_payloads p
          on p.tenant_id = i.tenant_id and p.intent_id = i.id
        where i.tenant_id = ${value.tenantId} and i.id = ${value.correctedIntentId}`
      if (!origin) throw new Error('Corrected Fiscal origin snapshot unavailable')
      const snapshot = openOrigin(
        this.masterKey,
        value.tenantId,
        value.correctedIntentId,
        Buffer.from(origin.payload_ciphertext),
      )
      const snapshotDigest = createHash('sha256').update(snapshot).digest('hex')
      if (snapshotDigest !== origin.payload_digest || snapshotDigest !== origin.intent_digest)
        throw new Error('Corrected Fiscal origin snapshot digest mismatch')
      const payload = salesFiscalOriginRecorded.payload.parse(JSON.parse(snapshot))
      const id = randomUUID()
      const revision = Number(predecessor.revision) + 1
      await tx`insert into fiscal_documents (
        id, tenant_id, intent_id, model, environment, establishment_id, series,
        snapshot_digest, snapshot_ciphertext, root_document_id, predecessor_document_id,
        revision
      ) values (
        ${id}, ${value.tenantId}, ${value.correctedIntentId}, ${predecessor.model},
        ${predecessor.environment}, ${predecessor.establishment_id}, ${predecessor.series},
        ${snapshotDigest}, ${encryptSnapshot(this.masterKey, value.tenantId, id, snapshot)},
        ${predecessor.root_document_id}, ${value.documentId}, ${revision}
      )`
      for (const [lineIndex, line] of payload.lines.entries()) {
        const lineDigest = createHash('sha256').update(JSON.stringify(line)).digest('hex')
        await tx`insert into fiscal_document_lines
          (tenant_id, document_id, line_index, item_id, line_digest)
          values (${value.tenantId}, ${id}, ${lineIndex}, ${line.itemId ?? null}, ${lineDigest})`
      }
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
        values (${randomUUID()}, ${value.tenantId}, ${id}, 'draft_created',
          ${JSON.stringify({ predecessorDocumentId: value.documentId, reasonDigest: createHash('sha256').update(value.reason).digest('hex') })}::jsonb)`
      await tx`insert into fiscal_idempotency
        (tenant_id, key, command, request_digest, document_id)
        values (${value.tenantId}, ${value.idempotencyKey}, 'document.correct',
          ${requestDigest}, ${id})`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'document.successor-created',
        resourceId: id,
        detail: {
          predecessorDocumentId: value.documentId,
          correctedIntentId: value.correctedIntentId,
          revision,
          requestDigest,
        },
      })
      return {
        id,
        status: 'draft',
        snapshotDigest,
        rootDocumentId: String(predecessor.root_document_id),
        predecessorDocumentId: value.documentId,
        revision,
        existing: false,
      }
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
      await appendAudit(tx, {
        tenantId,
        actorId: 'system:fiscal',
        action: 'document.number-reserved',
        resourceId: documentId,
        detail: { number },
      })
      return number
    })
  }
}

function correctedDraft(row: Record<string, unknown>, existing: boolean): CorrectedDraft {
  return {
    id: String(row.id),
    status: 'draft',
    snapshotDigest: String(row.snapshot_digest),
    rootDocumentId: String(row.root_document_id),
    predecessorDocumentId: String(row.predecessor_document_id),
    revision: Number(row.revision),
    existing,
  }
}

function snapshotKey(master: Buffer, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(tenantId), 'fiscal-document-snapshot-v1', 32),
  )
}

function encryptSnapshot(
  master: Buffer,
  tenantId: string,
  documentId: string,
  value: string,
): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', snapshotKey(master, tenantId), nonce)
  cipher.setAAD(Buffer.from(`${tenantId}:${documentId}`))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
}

function decryptSnapshot(
  master: Buffer,
  tenantId: string,
  documentId: string,
  packed: Buffer,
): string {
  if (packed.length < 29 || packed[0] !== 1) throw new Error('Invalid fiscal snapshot envelope')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    snapshotKey(master, tenantId),
    packed.subarray(1, 13),
  )
  decipher.setAAD(Buffer.from(`${tenantId}:${documentId}`))
  decipher.setAuthTag(packed.subarray(13, 29))
  return Buffer.concat([decipher.update(packed.subarray(29)), decipher.final()]).toString('utf8')
}
