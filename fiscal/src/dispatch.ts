import { randomUUID } from 'node:crypto'
import {
  fiscalDocumentAuthorized,
  fiscalDocumentCancelled,
  fiscalDocumentRejected,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import { canonicalDigest } from './canonical-json'

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const commandSchema = z.object({
  tenantId: z.uuid(),
  documentId: z.uuid(),
  idempotencyKey: z.string().min(16).max(128),
  requestDigest: digestSchema,
  artifactDigest: digestSchema.optional(),
  actorId: z.string().min(1).max(200),
})

const workerSchema = z.object({
  tenantId: z.uuid(),
  workerId: z.string().min(1).max(200),
  leaseMilliseconds: z.number().int().min(1_000).max(300_000).default(30_000),
})
const observationSchema = z.strictObject({
  tenantId: z.uuid(),
  commandId: z.uuid(),
  workerId: z.string().min(1).max(200),
  observationKind: z.enum(['response', 'callback', 'consultation']),
  outcome: z.enum(['authorized', 'rejected', 'cancelled', 'unknown']),
  providerCorrelation: z.string().min(1).max(256).nullable(),
  responseDigest: digestSchema,
  protocolDigest: digestSchema.nullable(),
})

export type DispatchCommand = {
  commandId: string
  documentId: string
  kind: 'issuance' | 'status_query' | 'cancellation' | 'cancellation_query'
  status: 'queued' | 'submitted' | 'unknown' | 'cancellation_pending' | 'cancellation_unknown'
  existing: boolean
}

export type DispatchLease = {
  tenantId: string
  commandId: string
  documentId: string
  kind: 'issuance' | 'status_query' | 'cancellation' | 'cancellation_query'
  requestDigest: string
  artifactDigest: string | null
  issuanceCommandId?: string | null
  cancellationCommandId?: string | null
  attemptCount: number
  leaseUntil: string
}

/** Durable Phase 42 command queue. Adapter I/O is deliberately outside its transactions. */
export class FiscalDispatch {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async findIssuance(
    tenantId: string,
    documentId: string,
    idempotencyKey: string,
  ): Promise<{
    commandId: string
    documentId: string
    status: string
    requestDigest: string
    signedXmlDigest: string
    accessKey: string
    unsignedXmlDigest: string
  } | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    z.string().min(16).max(128).parse(idempotencyKey)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select command.id, command.document_id, command.kind,
          command.request_digest, command.artifact_digest, document.status,
          binding.access_key, artifact.digest as unsigned_xml_digest
        from fiscal_dispatch_commands command
        join fiscal_documents document on document.tenant_id = command.tenant_id
          and document.id = command.document_id
        join fiscal_document_issuance_bindings binding on binding.tenant_id = command.tenant_id
          and binding.document_id = command.document_id
        join fiscal_artifacts artifact on artifact.tenant_id = command.tenant_id
          and artifact.document_id = command.document_id and artifact.kind = 'unsigned_xml'
        where command.tenant_id = ${tenantId} and command.idempotency_key = ${idempotencyKey}`
    })
    if (!row) return null
    if (row.document_id !== documentId || row.kind !== 'issuance')
      throw new Error('Conflicting Fiscal dispatch idempotency key')
    return {
      commandId: String(row.id),
      documentId,
      status: String(row.status),
      requestDigest: String(row.request_digest),
      signedXmlDigest: String(row.artifact_digest),
      accessKey: String(row.access_key),
      unsignedXmlDigest: String(row.unsigned_xml_digest),
    }
  }

  async findCancellation(
    tenantId: string,
    documentId: string,
    idempotencyKey: string,
  ): Promise<{
    commandId: string
    documentId: string
    status: string
    requestDigest: string
    artifactDigest: string
  } | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    z.string().min(16).max(128).parse(idempotencyKey)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select command.id, command.document_id, command.kind,
          command.request_digest, command.artifact_digest, document.status
        from fiscal_dispatch_commands command
        join fiscal_documents document on document.tenant_id = command.tenant_id
          and document.id = command.document_id
        where command.tenant_id = ${tenantId} and command.idempotency_key = ${idempotencyKey}`
    })
    if (!row) return null
    if (row.document_id !== documentId || row.kind !== 'cancellation')
      throw new Error('Conflicting Fiscal dispatch idempotency key')
    return {
      commandId: String(row.id),
      documentId,
      status: String(row.status),
      requestDigest: String(row.request_digest),
      artifactDigest: String(row.artifact_digest),
    }
  }

  async queueIssuance(input: z.input<typeof commandSchema>): Promise<DispatchCommand> {
    const value = commandSchema.extend({ artifactDigest: digestSchema }).parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const existing = await findCommand(tx, value.tenantId, value.idempotencyKey)
      if (existing) return verifyExisting(existing, value, 'issuance')

      const [document] = await tx`select status, model, environment, establishment_id, series
        from fiscal_documents where tenant_id = ${value.tenantId}
          and id = ${value.documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.status !== 'ready') throw new Error('Fiscal document is not ready')
      if (document.model !== '55' || document.environment !== 'simulation')
        throw new Error('Unsupported Fiscal issuance tuple')
      const [binding] = await tx`select binding.signed_xml_digest
        from fiscal_document_issuance_bindings binding
        join lateral (
          select event.action from fiscal_capability_activation_events event
          where event.tenant_id = binding.tenant_id
            and event.capability_id = binding.capability_id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action = 'activate_simulated'
        where binding.tenant_id = ${value.tenantId}
          and binding.document_id = ${value.documentId}`
      if (!binding) throw new Error('Fiscal document is not bound to an active capability')
      if (binding.signed_xml_digest !== value.artifactDigest)
        throw new Error('Fiscal signed XML digest does not match issuance binding')

      const [priorNumber] = await tx`select number from fiscal_number_reservations
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}`
      let number = priorNumber ? Number(priorNumber.number) : null
      if (number === null) {
        const [counter] = await tx`insert into fiscal_number_counters (
          tenant_id, establishment_id, environment, model, series, last_number
        ) values (
          ${value.tenantId}, ${document.establishment_id}, ${document.environment},
          ${document.model}, ${document.series}, 1
        ) on conflict (tenant_id, establishment_id, environment, model, series)
        do update set last_number = fiscal_number_counters.last_number + 1
        returning last_number`
        if (!counter) throw new Error('Could not reserve a fiscal number')
        number = Number(counter.last_number)
        await tx`insert into fiscal_number_reservations (
          tenant_id, document_id, establishment_id, environment, model, series, number
        ) values (
          ${value.tenantId}, ${value.documentId}, ${document.establishment_id},
          ${document.environment}, ${document.model}, ${document.series}, ${number}
        )`
        await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
          values (${randomUUID()}, ${value.tenantId}, ${value.documentId}, 'number_reserved',
            ${JSON.stringify({ number })}::jsonb)`
      }

      const commandId = randomUUID()
      await tx`insert into fiscal_dispatch_commands (
        id, tenant_id, document_id, kind, idempotency_key, request_digest,
        artifact_digest, actor_id
      ) values (
        ${commandId}, ${value.tenantId}, ${value.documentId}, 'issuance',
        ${value.idempotencyKey}, ${value.requestDigest}, ${value.artifactDigest}, ${value.actorId}
      )`
      await tx`insert into fiscal_dispatch_jobs (tenant_id, command_id)
        values (${value.tenantId}, ${commandId})`
      await tx`update fiscal_documents set status = 'queued'
        where tenant_id = ${value.tenantId} and id = ${value.documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
        values (${randomUUID()}, ${value.tenantId}, ${value.documentId}, 'queued',
          ${JSON.stringify({ commandId })}::jsonb)`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'document.issuance-queued',
        resourceId: value.documentId,
        detail: { commandId, number, requestDigest: value.requestDigest },
      })
      return {
        commandId,
        documentId: value.documentId,
        kind: 'issuance',
        status: 'queued',
        existing: false,
      }
    })
  }

  async queueStatusQuery(input: z.input<typeof commandSchema>): Promise<DispatchCommand> {
    const value = commandSchema.omit({ artifactDigest: true }).parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const existing = await findCommand(tx, value.tenantId, value.idempotencyKey)
      if (existing) return verifyExisting(existing, value, 'status_query')
      const [document] = await tx`select status from fiscal_documents
        where tenant_id = ${value.tenantId} and id = ${value.documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.status !== 'submitted' && document.status !== 'unknown')
        throw new Error('Fiscal document is not consultable')
      const [issuance] = await tx`select id from fiscal_dispatch_commands
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}
          and kind = 'issuance'`
      if (!issuance) throw new Error('Fiscal issuance command not found')
      const commandId = randomUUID()
      await tx`insert into fiscal_dispatch_commands (
        id, tenant_id, document_id, kind, idempotency_key, request_digest, actor_id
      ) values (
        ${commandId}, ${value.tenantId}, ${value.documentId}, 'status_query',
        ${value.idempotencyKey}, ${value.requestDigest}, ${value.actorId}
      )`
      await tx`insert into fiscal_dispatch_jobs (tenant_id, command_id)
        values (${value.tenantId}, ${commandId})`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'document.status-query-queued',
        resourceId: value.documentId,
        detail: { commandId, issuanceCommandId: String(issuance.id) },
      })
      return {
        commandId,
        documentId: value.documentId,
        kind: 'status_query',
        status: document.status as 'submitted' | 'unknown',
        existing: false,
      }
    })
  }

  async queueCancellation(input: z.input<typeof commandSchema>): Promise<DispatchCommand> {
    const value = commandSchema.extend({ artifactDigest: digestSchema }).parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const existing = await findCommand(tx, value.tenantId, value.idempotencyKey)
      if (existing)
        return verifyExisting(existing, { ...value, artifactDigest: undefined }, 'cancellation')
      const [document] = await tx`select status, model, environment from fiscal_documents
        where tenant_id = ${value.tenantId} and id = ${value.documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.status !== 'authorized') throw new Error('Fiscal cancellation is not allowed')
      if (document.model !== '55' || document.environment !== 'simulation')
        throw new Error('Unsupported Fiscal cancellation tuple')
      const [binding] = await tx`select binding.access_key
        from fiscal_document_issuance_bindings binding
        join lateral (
          select event.action from fiscal_capability_activation_events event
          where event.tenant_id = binding.tenant_id
            and event.capability_id = binding.capability_id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action = 'activate_simulated'
        where binding.tenant_id = ${value.tenantId}
          and binding.document_id = ${value.documentId}`
      if (!binding) throw new Error('Fiscal cancellation capability is inactive')
      const [prior] = await tx`select id from fiscal_dispatch_commands
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}
          and kind = 'cancellation'`
      if (prior) throw new Error('Conflicting Fiscal cancellation command')
      const [artifact] = await tx`select id from fiscal_artifacts
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}
          and kind = 'cancellation_request' and digest = ${value.artifactDigest}`
      if (!artifact) throw new Error('Fiscal cancellation request artifact not found')
      const commandId = randomUUID()
      await tx`insert into fiscal_dispatch_commands (
        id, tenant_id, document_id, kind, idempotency_key, request_digest,
        artifact_digest, actor_id
      ) values (
        ${commandId}, ${value.tenantId}, ${value.documentId}, 'cancellation',
        ${value.idempotencyKey}, ${value.requestDigest}, ${value.artifactDigest}, ${value.actorId}
      )`
      await tx`insert into fiscal_dispatch_jobs (tenant_id, command_id)
        values (${value.tenantId}, ${commandId})`
      await tx`update fiscal_documents set status = 'cancellation_pending'
        where tenant_id = ${value.tenantId} and id = ${value.documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
        values (${randomUUID()}, ${value.tenantId}, ${value.documentId},
          'cancellation_pending', ${JSON.stringify({ commandId })}::jsonb)`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'document.cancellation-queued',
        resourceId: value.documentId,
        detail: { commandId, requestDigest: value.requestDigest },
      })
      return {
        commandId,
        documentId: value.documentId,
        kind: 'cancellation',
        status: 'cancellation_pending',
        existing: false,
      }
    })
  }

  async queueCancellationQuery(input: z.input<typeof commandSchema>): Promise<DispatchCommand> {
    const value = commandSchema.omit({ artifactDigest: true }).parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const existing = await findCommand(tx, value.tenantId, value.idempotencyKey)
      if (existing) return verifyExisting(existing, value, 'cancellation_query')
      const [document] = await tx`select status from fiscal_documents
        where tenant_id = ${value.tenantId} and id = ${value.documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      if (document.status !== 'cancellation_unknown')
        throw new Error('Fiscal cancellation is not consultable')
      const [original] = await tx`select id from fiscal_dispatch_commands
        where tenant_id = ${value.tenantId} and document_id = ${value.documentId}
          and kind = 'cancellation'`
      if (!original) throw new Error('Fiscal cancellation command not found')
      const commandId = randomUUID()
      await tx`insert into fiscal_dispatch_commands (
        id, tenant_id, document_id, kind, idempotency_key, request_digest, actor_id
      ) values (
        ${commandId}, ${value.tenantId}, ${value.documentId}, 'cancellation_query',
        ${value.idempotencyKey}, ${value.requestDigest}, ${value.actorId}
      )`
      await tx`insert into fiscal_dispatch_jobs (tenant_id, command_id)
        values (${value.tenantId}, ${commandId})`
      await appendAudit(tx, {
        tenantId: value.tenantId,
        actorId: value.actorId,
        action: 'document.cancellation-query-queued',
        resourceId: value.documentId,
        detail: { commandId, cancellationCommandId: String(original.id) },
      })
      return {
        commandId,
        documentId: value.documentId,
        kind: 'cancellation_query',
        status: document.status as 'cancellation_pending' | 'cancellation_unknown',
        existing: false,
      }
    })
  }

  async claim(input: z.input<typeof workerSchema>): Promise<DispatchLease | null> {
    const value = workerSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [job] = await tx`select job.command_id, command.document_id, command.kind,
          command.request_digest, command.artifact_digest,
          issuance.id as issuance_command_id,
          issuance.request_digest as issuance_request_digest,
          issuance.artifact_digest as issuance_artifact_digest,
          cancellation.id as cancellation_command_id,
          cancellation.request_digest as cancellation_request_digest,
          cancellation.artifact_digest as cancellation_artifact_digest
        from fiscal_dispatch_jobs job
        join fiscal_dispatch_commands command on command.tenant_id = job.tenant_id
          and command.id = job.command_id
        left join lateral (
          select id, request_digest, artifact_digest from fiscal_dispatch_commands original
          where original.tenant_id = command.tenant_id
            and original.document_id = command.document_id and original.kind = 'issuance'
          order by original.created_at, original.id limit 1
        ) issuance on command.kind = 'status_query'
        left join lateral (
          select id, request_digest, artifact_digest from fiscal_dispatch_commands original
          where original.tenant_id = command.tenant_id
            and original.document_id = command.document_id and original.kind = 'cancellation'
          order by original.created_at, original.id limit 1
        ) cancellation on command.kind = 'cancellation_query'
        where job.tenant_id = ${value.tenantId} and job.next_attempt_at <= now()
          and (job.state = 'pending' or (job.state = 'leased' and job.lease_until <= now()))
        order by job.next_attempt_at, job.command_id for update of job skip locked limit 1`
      if (!job) return null
      const [leased] = await tx`update fiscal_dispatch_jobs set state = 'leased',
          lease_owner = ${value.workerId},
          lease_until = now() + (${value.leaseMilliseconds} * interval '1 millisecond'),
          attempt_count = attempt_count + 1, updated_at = now()
        where tenant_id = ${value.tenantId} and command_id = ${job.command_id}
        returning attempt_count, lease_until`
      if (!leased) throw new Error('Fiscal dispatch job disappeared while claiming')

      if (job.kind === 'issuance') {
        const [document] = await tx`select status from fiscal_documents
          where tenant_id = ${value.tenantId} and id = ${job.document_id} for update`
        if (!document) throw new Error('Fiscal document not found')
        if (document.status === 'queued') {
          await tx`update fiscal_documents set status = 'submitted'
            where tenant_id = ${value.tenantId} and id = ${job.document_id}`
          await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
            values (${randomUUID()}, ${value.tenantId}, ${job.document_id}, 'submitted',
              ${JSON.stringify({ commandId: String(job.command_id) })}::jsonb)`
        } else if (!['submitted', 'unknown'].includes(document.status)) {
          throw new Error('Fiscal issuance job has an invalid document state')
        }
      }
      if (job.kind === 'cancellation') {
        const [document] = await tx`select status from fiscal_documents
          where tenant_id = ${value.tenantId} and id = ${job.document_id} for update`
        if (
          !document ||
          !['cancellation_pending', 'cancellation_unknown'].includes(document.status)
        )
          throw new Error('Fiscal cancellation job has an invalid document state')
      }
      return {
        tenantId: value.tenantId,
        commandId: String(job.command_id),
        documentId: String(job.document_id),
        kind: job.kind as DispatchLease['kind'],
        requestDigest: String(
          job.issuance_request_digest ?? job.cancellation_request_digest ?? job.request_digest,
        ),
        artifactDigest: job.issuance_artifact_digest
          ? String(job.issuance_artifact_digest)
          : job.cancellation_artifact_digest
            ? String(job.cancellation_artifact_digest)
            : job.artifact_digest
              ? String(job.artifact_digest)
              : null,
        issuanceCommandId: job.issuance_command_id ? String(job.issuance_command_id) : null,
        cancellationCommandId: job.cancellation_command_id
          ? String(job.cancellation_command_id)
          : null,
        attemptCount: Number(leased.attempt_count),
        leaseUntil: new Date(leased.lease_until).toISOString(),
      }
    })
  }

  async complete(tenantId: string, commandId: string, workerId: string): Promise<void> {
    await this.finishLease(tenantId, commandId, workerId, null)
  }

  async retry(
    tenantId: string,
    commandId: string,
    workerId: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    if (Number.isNaN(nextAttemptAt.getTime())) throw new Error('Invalid next attempt instant')
    await this.finishLease(tenantId, commandId, workerId, nextAttemptAt)
  }

  async recordObservation(
    input: z.input<typeof observationSchema>,
  ): Promise<{ id: string; existing: boolean }> {
    const value = observationSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [lease] = await tx`select command.document_id, command.kind, job.lease_owner,
          job.lease_until, document.status
        from fiscal_dispatch_commands command
        join fiscal_dispatch_jobs job on job.tenant_id = command.tenant_id
          and job.command_id = command.id
        join fiscal_documents document on document.tenant_id = command.tenant_id
          and document.id = command.document_id
        where command.tenant_id = ${value.tenantId} and command.id = ${value.commandId}
        for update of job, document`
      if (!lease) throw new Error('Fiscal dispatch command not found')
      if (
        lease.lease_owner !== value.workerId ||
        !lease.lease_until ||
        new Date(lease.lease_until).getTime() <= Date.now()
      )
        throw new Error('Fiscal dispatch lease is not owned by worker')
      const isCancellation = lease.kind === 'cancellation' || lease.kind === 'cancellation_query'
      if (!isCancellation && value.outcome === 'cancelled')
        throw new Error('Issuance observation cannot cancel a Fiscal document')
      if (isCancellation && value.outcome === 'authorized')
        throw new Error('Cancellation observation cannot authorize a Fiscal document')

      const [priorFinal] = await tx`select outcome, response_digest, protocol_digest
        from fiscal_dispatch_observations where tenant_id = ${value.tenantId}
          and command_id = ${value.commandId}
          and outcome in ('authorized', 'rejected', 'cancelled')`
      if (
        priorFinal &&
        (priorFinal.outcome !== value.outcome ||
          priorFinal.response_digest !== value.responseDigest ||
          priorFinal.protocol_digest !== value.protocolDigest)
      )
        throw new Error('Conflicting final Fiscal observation')
      const id = randomUUID()
      const inserted = await tx`insert into fiscal_dispatch_observations (
          id, tenant_id, command_id, observation_kind, outcome, provider_correlation,
          response_digest, protocol_digest
        ) values (
          ${id}, ${value.tenantId}, ${value.commandId}, ${value.observationKind},
          ${value.outcome}, ${value.providerCorrelation}, ${value.responseDigest},
          ${value.protocolDigest}
        ) on conflict on constraint fiscal_dispatch_observation_identity do nothing returning id`
      const existing = inserted.length === 0
      if (existing) {
        const [same] = await tx`select id, outcome, provider_correlation, protocol_digest
          from fiscal_dispatch_observations where tenant_id = ${value.tenantId}
            and command_id = ${value.commandId}
            and observation_kind = ${value.observationKind}
            and response_digest = ${value.responseDigest}`
        if (
          !same ||
          same.outcome !== value.outcome ||
          same.provider_correlation !== value.providerCorrelation ||
          same.protocol_digest !== value.protocolDigest
        )
          throw new Error('Conflicting duplicate Fiscal observation')
      }
      const nextStatus = isCancellation
        ? value.outcome === 'unknown'
          ? 'cancellation_unknown'
          : value.outcome === 'cancelled'
            ? 'cancelled'
            : 'authorized'
        : value.outcome
      if (nextStatus === 'unknown') {
        if (lease.status === 'submitted')
          await transition(
            tx,
            value.tenantId,
            String(lease.document_id),
            'unknown',
            value.commandId,
          )
        else if (lease.status !== 'unknown')
          throw new Error('Fiscal document cannot accept an unknown observation')
      } else if (lease.status === 'submitted' || lease.status === 'unknown') {
        await transition(tx, value.tenantId, String(lease.document_id), nextStatus, value.commandId)
      } else if (isCancellation) {
        if (nextStatus === 'cancellation_unknown') {
          if (lease.status === 'cancellation_pending')
            await transition(
              tx,
              value.tenantId,
              String(lease.document_id),
              nextStatus,
              value.commandId,
            )
          else if (lease.status !== 'cancellation_unknown')
            throw new Error('Fiscal document cannot accept an uncertain cancellation')
        } else if (
          lease.status === 'cancellation_pending' ||
          lease.status === 'cancellation_unknown'
        )
          await transition(
            tx,
            value.tenantId,
            String(lease.document_id),
            nextStatus,
            value.commandId,
          )
        else if (lease.status !== nextStatus)
          throw new Error('Fiscal document cannot accept this cancellation observation')
      } else if (lease.status !== nextStatus) {
        throw new Error('Fiscal document cannot accept this final observation')
      }
      if (
        !existing &&
        (value.outcome === 'authorized' ||
          (!isCancellation && value.outcome === 'rejected') ||
          value.outcome === 'cancelled')
      )
        await appendSimulationEvent(tx, {
          tenantId: value.tenantId,
          documentId: String(lease.document_id),
          outcome: value.outcome as 'authorized' | 'rejected' | 'cancelled',
          providerCorrelation: value.providerCorrelation,
          responseDigest: value.responseDigest,
          protocolDigest: value.protocolDigest,
        })
      if (nextStatus !== 'unknown' && nextStatus !== 'cancellation_unknown')
        await tx`update fiscal_dispatch_jobs set state = 'done', lease_owner = null,
            lease_until = null, updated_at = now()
          where tenant_id = ${value.tenantId} and command_id = ${value.commandId}`
      if (
        nextStatus !== 'unknown' &&
        nextStatus !== 'cancellation_unknown' &&
        (lease.kind === 'status_query' || lease.kind === 'cancellation_query')
      )
        await tx`update fiscal_dispatch_jobs job set state = 'done', lease_owner = null,
            lease_until = null, updated_at = now()
          from fiscal_dispatch_commands command
          where job.tenant_id = ${value.tenantId} and job.command_id = command.id
            and command.tenant_id = job.tenant_id
            and command.document_id = ${lease.document_id}
            and command.kind = ${lease.kind === 'status_query' ? 'issuance' : 'cancellation'}
            and job.state <> 'done'`
      return {
        id: existing
          ? String(
              (
                await tx`select id from fiscal_dispatch_observations
        where tenant_id = ${value.tenantId} and command_id = ${value.commandId}
          and observation_kind = ${value.observationKind}
          and response_digest = ${value.responseDigest}`
              )[0]?.id,
            )
          : id,
        existing,
      }
    })
  }

  private async finishLease(
    tenantId: string,
    commandId: string,
    workerId: string,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    z.uuid().parse(tenantId)
    z.uuid().parse(commandId)
    z.string().min(1).max(200).parse(workerId)
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const changed = nextAttemptAt
        ? await tx`update fiscal_dispatch_jobs set state = 'pending', lease_owner = null,
            lease_until = null, next_attempt_at = ${nextAttemptAt}, updated_at = now()
          where tenant_id = ${tenantId} and command_id = ${commandId}
            and state = 'leased' and lease_owner = ${workerId} and lease_until > now()
          returning command_id`
        : await tx`update fiscal_dispatch_jobs set state = 'done', lease_owner = null,
            lease_until = null, updated_at = now()
          where tenant_id = ${tenantId} and command_id = ${commandId}
            and state = 'leased' and lease_owner = ${workerId} and lease_until > now()
          returning command_id`
      if (changed.length === 0) throw new Error('Fiscal dispatch lease is not owned by worker')
    })
  }
}

async function appendSimulationEvent(
  tx: postgres.TransactionSql,
  input: {
    tenantId: string
    documentId: string
    outcome: 'authorized' | 'rejected' | 'cancelled'
    providerCorrelation: string | null
    responseDigest: string
    protocolDigest: string | null
  },
): Promise<void> {
  const [document] = await tx`select document.root_document_id, document.revision,
      document.intent_id, document.manual_origin_id, capability.adapter_version
    from fiscal_documents document
    join fiscal_document_issuance_bindings binding on binding.tenant_id = document.tenant_id
      and binding.document_id = document.id
    join fiscal_capability_definitions capability on capability.tenant_id = binding.tenant_id
      and capability.id = binding.capability_id
    where document.tenant_id = ${input.tenantId} and document.id = ${input.documentId}`
  if (!document) throw new Error('Fiscal simulation event facts are unavailable')
  const observedAt = new Date().toISOString()
  const fact = {
    documentId: input.documentId,
    rootDocumentId: String(document.root_document_id),
    revision: Number(document.revision),
    originModule: document.intent_id ? ('sales' as const) : ('fiscal' as const),
    originDocumentType: document.intent_id ? ('shipment' as const) : ('manual-simulation' as const),
    originId: String(document.intent_id ?? document.manual_origin_id),
    originPurpose: document.intent_id ? ('original' as const) : ('manual' as const),
    model: '55' as const,
    environment: 'simulation' as const,
    simulated: true as const,
    adapterVersion: String(document.adapter_version),
    statusDigest: canonicalDigest({
      documentId: input.documentId,
      outcome: input.outcome,
      responseDigest: input.responseDigest,
      protocolDigest: input.protocolDigest,
    }),
    observedAt,
  }
  let eventType: string
  let payload: unknown
  if (input.outcome === 'authorized') {
    if (!input.providerCorrelation || !input.protocolDigest)
      throw new Error('Fiscal authorization evidence is incomplete')
    eventType = fiscalDocumentAuthorized.type
    payload = fiscalDocumentAuthorized.payload.parse({
      ...fact,
      authorityReference: input.providerCorrelation,
      protocolDigest: input.protocolDigest,
    })
  } else if (input.outcome === 'cancelled') {
    if (!input.providerCorrelation || !input.protocolDigest)
      throw new Error('Fiscal cancellation evidence is incomplete')
    eventType = fiscalDocumentCancelled.type
    payload = fiscalDocumentCancelled.payload.parse({
      ...fact,
      cancellationReference: input.providerCorrelation,
      cancellationProtocolDigest: input.protocolDigest,
    })
  } else {
    eventType = fiscalDocumentRejected.type
    payload = fiscalDocumentRejected.payload.parse({
      ...fact,
      authorityReference: input.providerCorrelation,
      rejectionCode: 'SIMULATED_REJECTION',
      rejectionReason: 'Deterministic simulation rejected the issuance request',
      responseDigest: input.responseDigest,
    })
  }
  await tx`insert into fiscal_outbox (tenant_id, event_id, event_type, payload)
    values (${input.tenantId}, ${randomUUID()}, ${eventType},
      ${tx.json(payload as postgres.JSONValue)})`
}

async function transition(
  tx: postgres.TransactionSql,
  tenantId: string,
  documentId: string,
  status: 'unknown' | 'authorized' | 'rejected' | 'cancellation_unknown' | 'cancelled',
  commandId: string,
): Promise<void> {
  await tx`update fiscal_documents set status = ${status}
    where tenant_id = ${tenantId} and id = ${documentId}`
  await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
    values (${randomUUID()}, ${tenantId}, ${documentId}, ${status},
      ${JSON.stringify({ commandId })}::jsonb)`
}

type StoredCommand = {
  id: unknown
  document_id: unknown
  kind: unknown
  request_digest: unknown
  artifact_digest: unknown
  status: unknown
}

async function findCommand(
  tx: postgres.TransactionSql,
  tenantId: string,
  idempotencyKey: string,
): Promise<StoredCommand | undefined> {
  const [row] = await tx`select command.id, command.document_id, command.kind,
      command.request_digest, command.artifact_digest, document.status
    from fiscal_dispatch_commands command
    join fiscal_documents document on document.tenant_id = command.tenant_id
      and document.id = command.document_id
    where command.tenant_id = ${tenantId} and command.idempotency_key = ${idempotencyKey}`
  return row as StoredCommand | undefined
}

function verifyExisting(
  existing: StoredCommand,
  input: z.infer<typeof commandSchema>,
  kind: DispatchCommand['kind'],
): DispatchCommand {
  if (
    existing.document_id !== input.documentId ||
    existing.kind !== kind ||
    existing.request_digest !== input.requestDigest ||
    (input.artifactDigest !== undefined && existing.artifact_digest !== input.artifactDigest)
  )
    throw new Error('Conflicting Fiscal dispatch idempotency key')
  return {
    commandId: String(existing.id),
    documentId: input.documentId,
    kind,
    status: existing.status as DispatchCommand['status'],
    existing: true,
  }
}
