import { createHash, randomUUID } from 'node:crypto'
import type { FiscalCorrectionLetter } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { appendAudit } from './audit'
import { canonicalDigest } from './canonical-json'
import { hasEventFlow } from './document-kinds'
import type { FiscalDocuments } from './documents'
import {
  signNfeEvent,
  validateNfeEventSchema,
  verifyNfeEventSignature,
} from './nfe55/cancellation-event'
import { serializeCorrectionLetterEvent } from './nfe55/correction-letter-event'
import type { SimulationCredential } from './nfe55/signature'
import {
  type CorrectionLetterSimulatorResult,
  type DeterministicNfe55Simulator,
  simulateCorrectionLetter,
} from './nfe55/simulator'

const commandSchema = z.strictObject({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  actorId: z.string().min(1).max(200),
  text: z.string().trim().min(15).max(1000),
  attestation: z.literal(true),
})
const MAX_SEQUENCE = 20

export class CorrectionLetterError extends Error {}

/**
 * The model 55 correction letter (event 110110). A letter never edits the authorized XML
 * or its status; its request, response and protocol are separate artifacts, and an
 * uncertain answer is consulted before the same signed bytes are sent again.
 */
export class FiscalCorrectionLetters {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly documents: Pick<FiscalDocuments, 'get'>,
    private readonly artifacts: Pick<FiscalArtifacts, 'get' | 'put'>,
    private readonly credential: SimulationCredential,
    private readonly schemaZip: Buffer,
    private readonly schemaDigest: string,
  ) {
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async request(input: z.input<typeof commandSchema>) {
    const command = commandSchema.parse(input)
    const requestDigest = canonicalDigest({ documentId: command.documentId, text: command.text })
    const prior = await this.findByKey(command.tenantId, command.idempotencyKey)
    if (prior) {
      if (prior.requestDigest !== requestDigest || prior.documentId !== command.documentId)
        throw new CorrectionLetterError('Conflicting correction letter idempotency key')
      return { letterId: prior.id, sequence: prior.sequence, existing: true }
    }
    const document = await this.documents.get(command.tenantId, command.documentId)
    if (!document) throw new Error('Fiscal document not found')
    if (!hasEventFlow(document.model, 'correction-letter'))
      throw new CorrectionLetterError('This document model has no approved correction flow')
    if (
      document.status !== 'authorized' ||
      document.environment !== 'simulation' ||
      !document.accessKey
    )
      throw new CorrectionLetterError('A correction letter needs an authorized NF-e')
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:correction:${command.documentId}`}, 0))`
      const [again] = await tx`select id, sequence, request_digest, document_id
        from fiscal_correction_letters where tenant_id = ${command.tenantId}
          and idempotency_key = ${command.idempotencyKey}`
      if (again) {
        if (again.request_digest !== requestDigest || again.document_id !== command.documentId)
          throw new CorrectionLetterError('Conflicting correction letter idempotency key')
        return { letterId: String(again.id), sequence: Number(again.sequence), existing: true }
      }
      const [open] = await tx`select id from fiscal_correction_letters
        where tenant_id = ${command.tenantId} and document_id = ${command.documentId}
          and state <> 'done'`
      if (open) throw new CorrectionLetterError('A previous correction letter is unresolved')
      const [last] = await tx`select coalesce(max(sequence), 0)::integer as sequence
        from fiscal_correction_letters where tenant_id = ${command.tenantId}
          and document_id = ${command.documentId}`
      const sequence = Number(last?.sequence ?? 0) + 1
      if (sequence > MAX_SEQUENCE)
        throw new CorrectionLetterError('The document has used every correction sequence')
      const event = serializeCorrectionLetterEvent({
        accessKey: String(document.accessKey),
        sequence,
        text: command.text,
        occurredAt: `${new Date().toISOString().slice(0, 19)}+00:00`,
        lotId: lotIdOf(`${command.documentId}:${sequence}`),
      })
      const signed = signNfeEvent(event, this.credential)
      verifyNfeEventSignature(signed, this.credential.certificate)
      await validateNfeEventSchema({
        xml: signed,
        schemaZip: this.schemaZip,
        expectedZipDigest: this.schemaDigest,
      })
      const artifact = await this.artifacts.put(
        {
          tenantId: command.tenantId,
          documentId: command.documentId,
          kind: 'correction_request',
          mediaType: 'application/xml',
          sourceSchema: `PL_010d_v1.03:${this.schemaDigest}`,
        },
        signed,
      )
      const id = randomUUID()
      await tx`insert into fiscal_correction_letters (
          id, tenant_id, document_id, sequence, idempotency_key, request_digest, text_digest,
          event_xml_digest, attestation, actor_id
        ) values (
          ${id}, ${command.tenantId}, ${command.documentId}, ${sequence},
          ${command.idempotencyKey}, ${requestDigest},
          ${createHash('sha256').update(command.text).digest('hex')}, ${artifact.digest},
          true, ${command.actorId}
        )`
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'document.correction-letter-queued',
        resourceId: command.documentId,
        detail: { letterId: id, sequence, eventXmlDigest: artifact.digest },
      })
      return { letterId: id, sequence, existing: false }
    })
  }

  async list(
    tenantId: string,
    documentId: string,
  ): Promise<{ documentId: string; letters: FiscalCorrectionLetter[] } | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [document] = await tx`select id from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
      if (!document) return null
      return tx`select letter.id, letter.sequence, letter.text_digest, letter.event_xml_digest,
          letter.actor_id, letter.created_at, letter.state, final.outcome, final.protocol_digest,
          exists (select 1 from fiscal_correction_letter_observations observation
            where observation.tenant_id = letter.tenant_id and observation.letter_id = letter.id
              and observation.outcome = 'unknown') as uncertain
        from fiscal_correction_letters letter
        left join fiscal_correction_letter_observations final
          on final.tenant_id = letter.tenant_id and final.letter_id = letter.id
          and final.outcome in ('registered', 'rejected')
        where letter.tenant_id = ${tenantId} and letter.document_id = ${documentId}
        order by letter.sequence`
    })
    if (!rows) return null
    return {
      documentId,
      letters: rows.map((row) => ({
        id: String(row.id),
        documentId,
        sequence: Number(row.sequence),
        status: row.outcome
          ? (row.outcome as 'registered' | 'rejected')
          : row.uncertain
            ? 'unknown'
            : 'pending',
        textDigest: String(row.text_digest),
        eventXmlDigest: String(row.event_xml_digest),
        protocolDigest: row.protocol_digest ? String(row.protocol_digest) : null,
        simulated: true,
        requestedBy: String(row.actor_id),
        requestedAt: new Date(row.created_at).toISOString(),
      })),
    }
  }

  /** Claims one due letter, sends or consults it, and records the observation. */
  async processOne(
    tenantId: string,
    workerId: string,
    simulator: Pick<DeterministicNfe55Simulator, 'submitCancellation' | 'consultCancellation'>,
    retryDelayMilliseconds = 1_000,
  ): Promise<boolean> {
    const lease = await this.claim(tenantId, workerId)
    if (!lease) return false
    const request = {
      commandId: lease.id,
      requestDigest: lease.requestDigest,
      eventXmlDigest: lease.eventXmlDigest,
      attemptCount: lease.attemptCount,
    }
    const eventXml = async () =>
      (
        await this.artifacts.get(
          tenantId,
          lease.documentId,
          'correction_request',
          lease.eventXmlDigest,
        )
      ).bytes
    let observation: CorrectionLetterSimulatorResult
    let kind: 'response' | 'consultation' = 'response'
    if (lease.attemptCount === 1)
      observation = await simulateCorrectionLetter(
        simulator,
        { ...request, eventXml: await eventXml() },
        'submit',
      )
    else {
      kind = 'consultation'
      observation = await simulateCorrectionLetter(simulator, request, 'consult')
      if (observation.outcome === 'not_found') {
        kind = 'response'
        observation = await simulateCorrectionLetter(
          simulator,
          { ...request, eventXml: await eventXml() },
          'submit',
        )
      }
    }
    const response = await this.artifacts.put(
      {
        tenantId,
        documentId: lease.documentId,
        kind: 'correction_response',
        mediaType: 'application/json',
        sourceSchema: 'horizon-nfe55-simulator-v1',
      },
      observation.response,
    )
    const protocol = observation.protocol
      ? await this.artifacts.put(
          {
            tenantId,
            documentId: lease.documentId,
            kind: 'correction_protocol',
            mediaType: 'application/json',
            sourceSchema: 'horizon-nfe55-simulator-v1',
          },
          observation.protocol,
        )
      : null
    const outcome = observation.outcome === 'not_found' ? 'unknown' : observation.outcome
    await this.record(tenantId, lease.id, workerId, {
      kind,
      outcome,
      providerCorrelation: observation.providerCorrelation,
      responseDigest: response.digest,
      protocolDigest: protocol?.digest ?? null,
      nextAttemptAt: new Date(Date.now() + retryDelayMilliseconds),
    })
    return true
  }

  private async claim(tenantId: string, workerId: string) {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [row] = await tx`update fiscal_correction_letters set state = 'leased',
          lease_owner = ${workerId}, lease_until = now() + interval '30 seconds',
          attempt_count = attempt_count + 1, updated_at = now()
        where tenant_id = ${tenantId} and id = (
          select id from fiscal_correction_letters
          where tenant_id = ${tenantId} and next_attempt_at <= now()
            and (state = 'pending' or (state = 'leased' and lease_until <= now()))
          order by next_attempt_at, id for update skip locked limit 1
        ) returning id, document_id, request_digest, event_xml_digest, attempt_count`
      if (!row) return null
      return {
        id: String(row.id),
        documentId: String(row.document_id),
        requestDigest: String(row.request_digest),
        eventXmlDigest: String(row.event_xml_digest),
        attemptCount: Number(row.attempt_count),
      }
    })
  }

  private async record(
    tenantId: string,
    letterId: string,
    workerId: string,
    value: {
      kind: 'response' | 'consultation'
      outcome: 'registered' | 'rejected' | 'unknown'
      providerCorrelation: string | null
      responseDigest: string
      protocolDigest: string | null
      nextAttemptAt: Date
    },
  ): Promise<void> {
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [lease] = await tx`select document_id from fiscal_correction_letters
        where tenant_id = ${tenantId} and id = ${letterId} and state = 'leased'
          and lease_owner = ${workerId} and lease_until > now() for update`
      if (!lease) throw new Error('Fiscal correction letter lease is not owned by worker')
      await tx`insert into fiscal_correction_letter_observations (
          id, tenant_id, letter_id, observation_kind, outcome, provider_correlation,
          response_digest, protocol_digest
        ) values (
          ${randomUUID()}, ${tenantId}, ${letterId}, ${value.kind}, ${value.outcome},
          ${value.providerCorrelation}, ${value.responseDigest}, ${value.protocolDigest}
        ) on conflict on constraint fiscal_correction_observation_identity do nothing`
      if (value.outcome === 'unknown')
        await tx`update fiscal_correction_letters set state = 'pending', lease_owner = null,
            lease_until = null, next_attempt_at = ${value.nextAttemptAt}, updated_at = now()
          where tenant_id = ${tenantId} and id = ${letterId}`
      else {
        await tx`update fiscal_correction_letters set state = 'done', lease_owner = null,
            lease_until = null, updated_at = now()
          where tenant_id = ${tenantId} and id = ${letterId}`
        await appendAudit(tx, {
          tenantId,
          actorId: 'system:fiscal',
          action: `document.correction-letter-${value.outcome}`,
          resourceId: String(lease.document_id),
          detail: { letterId, responseDigest: value.responseDigest },
        })
      }
    })
  }

  private async findByKey(tenantId: string, key: string) {
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select id, sequence, request_digest, document_id from fiscal_correction_letters
        where tenant_id = ${tenantId} and idempotency_key = ${key}`
    })
    return row
      ? {
          id: String(row.id),
          sequence: Number(row.sequence),
          requestDigest: String(row.request_digest),
          documentId: String(row.document_id),
        }
      : null
  }
}

function lotIdOf(seed: string): string {
  return createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, 15)
    .split('')
    .map((digit) => String(Number.parseInt(digit, 16) % 10))
    .join('')
}
