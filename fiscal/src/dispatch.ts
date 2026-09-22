import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'

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
  kind: 'issuance' | 'status_query'
  status: 'queued' | 'submitted' | 'unknown'
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

  async claim(input: z.input<typeof workerSchema>): Promise<DispatchLease | null> {
    const value = workerSchema.parse(input)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${value.tenantId}, true)`
      const [job] = await tx`select job.command_id, command.document_id, command.kind,
          command.request_digest, command.artifact_digest,
          issuance.id as issuance_command_id,
          issuance.request_digest as issuance_request_digest,
          issuance.artifact_digest as issuance_artifact_digest
        from fiscal_dispatch_jobs job
        join fiscal_dispatch_commands command on command.tenant_id = job.tenant_id
          and command.id = job.command_id
        left join lateral (
          select id, request_digest, artifact_digest from fiscal_dispatch_commands original
          where original.tenant_id = command.tenant_id
            and original.document_id = command.document_id and original.kind = 'issuance'
          order by original.created_at, original.id limit 1
        ) issuance on command.kind = 'status_query'
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
      return {
        tenantId: value.tenantId,
        commandId: String(job.command_id),
        documentId: String(job.document_id),
        kind: job.kind as DispatchLease['kind'],
        requestDigest: String(job.issuance_request_digest ?? job.request_digest),
        artifactDigest: job.issuance_artifact_digest
          ? String(job.issuance_artifact_digest)
          : job.artifact_digest
            ? String(job.artifact_digest)
            : null,
        issuanceCommandId: job.issuance_command_id ? String(job.issuance_command_id) : null,
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
      if (lease.kind !== 'issuance' && lease.kind !== 'status_query')
        throw new Error('Fiscal observation does not match dispatch command kind')
      if (value.outcome === 'cancelled')
        throw new Error('Issuance observation cannot cancel a Fiscal document')

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
      const nextStatus = value.outcome
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
      } else if (lease.status !== nextStatus) {
        throw new Error('Fiscal document cannot accept this final observation')
      }
      if (nextStatus !== 'unknown')
        await tx`update fiscal_dispatch_jobs set state = 'done', lease_owner = null,
            lease_until = null, updated_at = now()
          where tenant_id = ${value.tenantId} and command_id = ${value.commandId}`
      if (nextStatus !== 'unknown' && lease.kind === 'status_query')
        await tx`update fiscal_dispatch_jobs job set state = 'done', lease_owner = null,
            lease_until = null, updated_at = now()
          from fiscal_dispatch_commands command
          where job.tenant_id = ${value.tenantId} and job.command_id = command.id
            and command.tenant_id = job.tenant_id
            and command.document_id = ${lease.document_id}
            and command.kind = 'issuance' and job.state <> 'done'`
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

async function transition(
  tx: postgres.TransactionSql,
  tenantId: string,
  documentId: string,
  status: 'unknown' | 'authorized' | 'rejected',
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
  kind: 'issuance' | 'status_query',
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
