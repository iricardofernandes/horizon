import { createHash, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import {
  type AuthorityGateway,
  type AuthorityObservation,
  type AuthorityRequest,
  type CancellationObservation,
  type CancellationRequest,
  type Clock,
  SystemClock,
} from './ports'

type Prepared = {
  request: AuthorityRequest
  fresh: boolean
  final: 'authorized' | 'rejected' | null
}

type PreparedCancellation = {
  request: CancellationRequest
  fresh: boolean
  final: 'cancelled' | 'rejected' | null
}

/** Generic crash-safe lifecycle foundation. Only simulation documents can enter it. */
export class FiscalLifecycle {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly authority: AuthorityGateway,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async validate(tenantId: string, documentId: string): Promise<void> {
    validateIds(tenantId, documentId)
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [document] = await tx`select status, environment, snapshot_ciphertext
        from fiscal_documents where tenant_id = ${tenantId} and id = ${documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.status === 'validated') return
      if (
        document.status !== 'draft' ||
        document.environment !== 'simulation' ||
        !document.snapshot_ciphertext
      )
        throw new Error('Fiscal document is not a valid simulation draft')
      await tx`update fiscal_documents set status = 'validated'
        where tenant_id = ${tenantId} and id = ${documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind)
        values (${randomUUID()}, ${tenantId}, ${documentId}, 'validated')`
      await appendAudit(tx, {
        tenantId,
        actorId: 'system:fiscal',
        action: 'document.validated',
        resourceId: documentId,
        detail: { environment: 'simulation' },
      })
    })
  }

  async prepareSubmission(tenantId: string, documentId: string): Promise<Prepared> {
    validateIds(tenantId, documentId)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [document] = await tx`select status, environment, snapshot_digest
        from fiscal_documents where tenant_id = ${tenantId} and id = ${documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.environment !== 'simulation') throw new Error('Unsupported fiscal environment')
      const [attempt] = await tx`select request_id, number, payload_digest
        from authority_attempts where tenant_id = ${tenantId} and document_id = ${documentId}`
      if (attempt) {
        const final =
          document.status === 'authorized' || document.status === 'rejected'
            ? (document.status as 'authorized' | 'rejected')
            : null
        return {
          request: {
            requestId: String(attempt.request_id),
            tenantId,
            documentId,
            snapshotDigest: String(attempt.payload_digest),
            number: Number(attempt.number),
          },
          fresh: false,
          final,
        }
      }
      if (document.status !== 'validated') throw new Error('Fiscal document is not validated')
      const [reservation] = await tx`select number from fiscal_number_reservations
        where tenant_id = ${tenantId} and document_id = ${documentId}`
      if (!reservation) throw new Error('Fiscal number has not been reserved')
      const requestId = randomUUID()
      const number = Number(reservation.number)
      await tx`insert into authority_attempts
        (id, tenant_id, document_id, request_id, number, payload_digest)
        values (${randomUUID()}, ${tenantId}, ${documentId}, ${requestId},
          ${number}, ${document.snapshot_digest})`
      await tx`update fiscal_documents set status = 'submitted'
        where tenant_id = ${tenantId} and id = ${documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
        values (${randomUUID()}, ${tenantId}, ${documentId}, 'submitted',
          ${JSON.stringify({ requestId })}::jsonb)`
      await appendAudit(tx, {
        tenantId,
        actorId: 'system:fiscal',
        action: 'document.simulation-submitted',
        resourceId: documentId,
        detail: { requestId, number },
      })
      return {
        request: {
          requestId,
          tenantId,
          documentId,
          snapshotDigest: String(document.snapshot_digest),
          number,
        },
        fresh: true,
        final: null,
      }
    })
  }

  async submit(tenantId: string, documentId: string): Promise<AuthorityObservation> {
    const prepared = await this.prepareSubmission(tenantId, documentId)
    if (prepared.final) return { outcome: prepared.final, providerReference: null }
    let observation: AuthorityObservation
    try {
      observation = prepared.fresh
        ? await this.authority.submit(prepared.request)
        : await this.authority.consult(prepared.request)
    } catch {
      observation = { outcome: 'unknown', providerReference: null }
    }
    await this.recordObservation(prepared.request, observation)
    return observation
  }

  async reconcile(tenantId: string, documentId: string): Promise<AuthorityObservation> {
    const prepared = await this.prepareSubmission(tenantId, documentId)
    if (prepared.final) return { outcome: prepared.final, providerReference: null }
    const observation = await this.authority.consult(prepared.request)
    await this.recordObservation(prepared.request, observation)
    return observation
  }

  async requestCancellation(
    tenantId: string,
    documentId: string,
    reason: string,
  ): Promise<CancellationObservation> {
    z.string().min(10).max(1024).parse(reason)
    const prepared = await this.prepareCancellation(tenantId, documentId, reason)
    if (prepared.final) return { outcome: prepared.final, providerReference: null }
    let observation: CancellationObservation
    try {
      observation = prepared.fresh
        ? await this.authority.cancel(prepared.request)
        : await this.authority.consultCancellation(prepared.request)
    } catch {
      observation = { outcome: 'unknown', providerReference: null }
    }
    await this.recordCancellation(prepared.request, observation)
    return observation
  }

  async reconcileCancellation(
    tenantId: string,
    documentId: string,
  ): Promise<CancellationObservation> {
    const prepared = await this.prepareCancellation(tenantId, documentId)
    if (prepared.final) return { outcome: prepared.final, providerReference: null }
    const observation = await this.authority.consultCancellation(prepared.request)
    await this.recordCancellation(prepared.request, observation)
    return observation
  }

  private async prepareCancellation(
    tenantId: string,
    documentId: string,
    reason?: string,
  ): Promise<PreparedCancellation> {
    validateIds(tenantId, documentId)
    const reasonDigest = reason ? createHash('sha256').update(reason).digest('hex') : null
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [document] = await tx`select status, environment from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.environment !== 'simulation') throw new Error('Unsupported fiscal environment')
      const [existing] = await tx`select request_id, reason_digest from cancellation_attempts
        where tenant_id = ${tenantId} and document_id = ${documentId}`
      if (existing) {
        if (reasonDigest && reasonDigest !== existing.reason_digest)
          throw new Error('Conflicting Fiscal cancellation reason')
        const final =
          document.status === 'cancelled'
            ? ('cancelled' as const)
            : document.status === 'authorized'
              ? ('rejected' as const)
              : null
        return {
          request: {
            requestId: String(existing.request_id),
            tenantId,
            documentId,
            reasonDigest: String(existing.reason_digest),
          },
          fresh: false,
          final,
        }
      }
      if (document.status !== 'authorized' || !reasonDigest)
        throw new Error('Fiscal document is not authorized for cancellation')
      const requestId = randomUUID()
      await tx`insert into cancellation_attempts
        (id, tenant_id, document_id, request_id, reason_digest)
        values (${randomUUID()}, ${tenantId}, ${documentId}, ${requestId}, ${reasonDigest})`
      await tx`update fiscal_documents set status = 'cancellation_pending'
        where tenant_id = ${tenantId} and id = ${documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind)
        values (${randomUUID()}, ${tenantId}, ${documentId}, 'cancellation_pending')`
      await appendAudit(tx, {
        tenantId,
        actorId: 'system:fiscal',
        action: 'document.simulation-cancellation-requested',
        resourceId: documentId,
        detail: { requestId, reasonDigest },
      })
      return {
        request: { requestId, tenantId, documentId, reasonDigest },
        fresh: true,
        final: null,
      }
    })
  }

  private async recordCancellation(
    request: CancellationRequest,
    observation: CancellationObservation,
  ): Promise<void> {
    const value = z
      .object({
        outcome: z.enum(['cancelled', 'rejected', 'unknown']),
        providerReference: z.string().max(256).nullable(),
      })
      .parse(observation)
    const responseDigest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${request.tenantId}, true)`
      const [document] = await tx`select status from fiscal_documents
        where tenant_id = ${request.tenantId} and id = ${request.documentId} for update`
      const [attempt] = await tx`select id from cancellation_attempts
        where tenant_id = ${request.tenantId} and request_id = ${request.requestId}`
      if (!document || !attempt) throw new Error('Fiscal cancellation attempt not found')
      if (document.status !== 'cancellation_pending') {
        const final = document.status === 'cancelled' ? 'cancelled' : 'rejected'
        if (final !== value.outcome) throw new Error('Conflicting Fiscal cancellation outcome')
        return
      }
      await tx`insert into cancellation_responses
        (id, tenant_id, attempt_id, outcome, provider_reference, response_digest,
          observed_at)
        values (${randomUUID()}, ${request.tenantId}, ${attempt.id}, ${value.outcome},
          ${value.providerReference}, ${responseDigest}, ${this.clock.now()})
        on conflict on constraint cancellation_response_unique do nothing`
      if (value.outcome === 'unknown') return
      const status = value.outcome === 'cancelled' ? 'cancelled' : 'authorized'
      await tx`update fiscal_documents set status = ${status}
        where tenant_id = ${request.tenantId} and id = ${request.documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind)
        values (${randomUUID()}, ${request.tenantId}, ${request.documentId}, ${status})`
      await appendAudit(tx, {
        tenantId: request.tenantId,
        actorId: 'system:fiscal-simulator',
        action: `document.simulation-cancellation-${value.outcome}`,
        resourceId: request.documentId,
        detail: { requestId: request.requestId, responseDigest },
      })
    })
  }

  private async recordObservation(
    request: AuthorityRequest,
    observation: AuthorityObservation,
  ): Promise<void> {
    const value = z
      .object({
        outcome: z.enum(['authorized', 'rejected', 'unknown']),
        providerReference: z.string().max(256).nullable(),
      })
      .parse(observation)
    const responseDigest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${request.tenantId}, true)`
      const [document] = await tx`select status from fiscal_documents
        where tenant_id = ${request.tenantId} and id = ${request.documentId} for update`
      const [attempt] = await tx`select id from authority_attempts
        where tenant_id = ${request.tenantId} and request_id = ${request.requestId}`
      if (!document || !attempt) throw new Error('Fiscal authority attempt not found')
      if (['authorized', 'rejected', 'cancelled'].includes(document.status)) {
        if (document.status !== value.outcome)
          throw new Error('Conflicting Fiscal authority outcome')
        return
      }
      await tx`insert into authority_responses
        (id, tenant_id, attempt_id, outcome, provider_reference, response_digest,
          observed_at)
        values (${randomUUID()}, ${request.tenantId}, ${attempt.id}, ${value.outcome},
          ${value.providerReference}, ${responseDigest}, ${this.clock.now()})
        on conflict on constraint authority_response_unique do nothing`
      if (document.status === value.outcome) return
      await tx`update fiscal_documents set status = ${value.outcome}
        where tenant_id = ${request.tenantId} and id = ${request.documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind)
        values (${randomUUID()}, ${request.tenantId}, ${request.documentId}, ${value.outcome})`
      await appendAudit(tx, {
        tenantId: request.tenantId,
        actorId: 'system:fiscal-simulator',
        action: `document.simulation-${value.outcome}`,
        resourceId: request.documentId,
        detail: { requestId: request.requestId, responseDigest },
      })
    })
  }
}

function validateIds(tenantId: string, documentId: string): void {
  z.uuid().parse(tenantId)
  z.uuid().parse(documentId)
}
