import { randomUUID } from 'node:crypto'
import { type FiscalSupportOverview, fiscalSupportOverviewSchema } from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import { canonicalDigest } from './canonical-json'
import { INBOUND_STATUS_SQL } from './inbound-imports'

/** A certificate this close to expiry is `expiring`; the runbook names the rotation. */
export const CERTIFICATE_WARNING_DAYS = 30
/** Rejection codes are counted over this window. */
const REJECTION_WINDOW_DAYS = 7
/** No support command touches more rows than this in one run. */
export const SUPPORT_COMMAND_LIMIT = 100
const DAY_SECONDS = 86_400

const limitSchema = z.number().int().min(1).max(SUPPORT_COMMAND_LIMIT)
const actorSchema = z.string().min(1).max(200)
const reasonSchema = z.string().trim().min(10).max(500)

/** Aggregate over the served tenants; it carries no tenant, document or party. */
export type FiscalSupportTotals = {
  queuePending: number
  queueLeased: number
  queueOldestDueSeconds: number
  unknownOutcomes: number
  certificateMinDaysRemaining: number | null
  certificatesExpiring: number
  certificatesExpired: number
  importsBlocked: number
  importsOpen: number
  outboxUndelivered: number
  outboxOldestSeconds: number
  sourcePackageMaxAgeDays: number | null
}

export type SupportCommandResult = {
  command: 'reconcile-unknown' | 'retry-due' | 'replay-outbox'
  tenantId: string
  changed: { id: string; detail: string }[]
  skipped: { id: string; reason: string }[]
}

/**
 * The operator's view of one tenant's Fiscal context, and the bounded commands that act on
 * it. Every command reuses an idempotent path that already exists: a consultation before
 * any resend, a pending job brought forward, or an event republished under its own id.
 */
export class FiscalSupport {
  readonly #db: ReturnType<typeof postgres>

  constructor(databaseUrl: string) {
    this.#db = postgres(databaseUrl, { max: 4, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async overview(tenantId: string, now = new Date()): Promise<FiscalSupportOverview> {
    z.uuid().parse(tenantId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [queue] = await tx`select
          count(*) filter (where state = 'pending')::int as pending,
          count(*) filter (where state = 'leased')::int as leased,
          coalesce(extract(epoch from (${now}::timestamptz - min(next_attempt_at)
            filter (where state = 'pending' and next_attempt_at <= ${now}::timestamptz))), 0)
            as oldest_due,
          coalesce(max(attempt_count) filter (where state <> 'done'), 0)::int as max_attempts
        from fiscal_dispatch_jobs where tenant_id = ${tenantId}`
      const statuses = await tx`select status, count(*)::int as count from fiscal_documents
        where tenant_id = ${tenantId} group by status`
      const rejections = await tx`select payload->>'rejectionCode' as code,
          count(*)::int as count, max(created_at) as last_observed
        from fiscal_outbox where tenant_id = ${tenantId} and payload ? 'rejectionCode'
          and created_at > ${now}::timestamptz - ${`${REJECTION_WINDOW_DAYS} days`}::interval
        group by 1 order by 2 desc, 1 limit 20`
      const certificates = await tx`select establishment_id, fingerprint, valid_until
        from fiscal_establishment_credentials where tenant_id = ${tenantId} and active
        order by valid_until`
      const imports = await tx`select status, count(*)::int as count from (
          select ${tx.unsafe(INBOUND_STATUS_SQL)} as status from fiscal_inbound_documents d
          where d.tenant_id = ${tenantId}) s group by status`
      const [outbox] = await tx`select count(*)::int as undelivered,
          coalesce(extract(epoch from (${now}::timestamptz - min(created_at))), 0) as oldest
        from fiscal_outbox where tenant_id = ${tenantId} and delivered_at is null`
      const packages = await tx`select id, authority, published_at, imported_at
        from fiscal_source_packages where tenant_id = ${tenantId}
        order by imported_at desc, id limit 50`
      // The same activation reading as the capability read API: the latest event decides.
      const capabilities = await tx`select definition.id, definition.model,
          definition.environment, definition.establishment_id, definition.jurisdiction_kind,
          definition.jurisdiction_code, definition.operation, definition.adapter_version,
          latest.occurred_at
        from fiscal_capability_definitions definition
        join lateral (
          select action, occurred_at from fiscal_capability_activation_events event
          where event.tenant_id = definition.tenant_id and event.capability_id = definition.id
          order by event.created_at desc, event.id desc limit 1
        ) latest on latest.action in ('activate_simulated', 'activate_homologated')
        where definition.tenant_id = ${tenantId}
          and definition.environment in ('simulation', 'homologation')
        order by definition.model, definition.environment, definition.jurisdiction_code,
          definition.operation`
      return { queue, statuses, rejections, certificates, imports, outbox, packages, capabilities }
    })
    const documents = Object.fromEntries(
      rows.statuses.map((row) => [String(row.status), Number(row.count)]),
    )
    const importCount = (status: string) =>
      Number(rows.imports.find((row) => row.status === status)?.count ?? 0)
    return fiscalSupportOverviewSchema.parse({
      generatedAt: now.toISOString(),
      simulationOnly: rows.capabilities.every((row) => row.environment === 'simulation'),
      queue: {
        pending: Number(rows.queue?.pending ?? 0),
        leased: Number(rows.queue?.leased ?? 0),
        oldestDueSeconds: seconds(rows.queue?.oldest_due),
        maxAttemptCount: Number(rows.queue?.max_attempts ?? 0),
      },
      documents,
      unknownOutcomes: (documents.unknown ?? 0) + (documents.cancellation_unknown ?? 0),
      rejections: rows.rejections.map((row) => ({
        code: String(row.code).slice(0, 40),
        count: Number(row.count),
        lastObservedAt: instant(row.last_observed),
      })),
      certificates: rows.certificates.map((row) => certificate(row, now)),
      imports: {
        open: importCount('open'),
        blocked: importCount('blocked'),
        reconciled: importCount('reconciled'),
      },
      outbox: {
        undelivered: Number(rows.outbox?.undelivered ?? 0),
        oldestUndeliveredSeconds: seconds(rows.outbox?.oldest),
      },
      capabilities: rows.capabilities.map((row) => ({
        id: String(row.id),
        model: String(row.model),
        environment: String(row.environment),
        establishmentId: String(row.establishment_id),
        jurisdiction: { kind: String(row.jurisdiction_kind), code: String(row.jurisdiction_code) },
        operation: String(row.operation),
        adapterVersion: String(row.adapter_version),
        status: row.environment === 'homologation' ? 'homologated' : 'simulated',
        activatedAt: instant(row.occurred_at),
      })),
      sourcePackages: rows.packages.map((row) => ({
        id: String(row.id),
        authority: String(row.authority).slice(0, 200),
        publishedAt: date(row.published_at),
        importedAt: instant(row.imported_at),
        ageDays: Math.max(
          0,
          Math.floor((now.getTime() - new Date(row.imported_at).getTime()) / (DAY_SECONDS * 1000)),
        ),
      })),
    })
  }

  /** Sums the tenants the worker serves; used by the metric gauges. */
  async totals(tenantIds: readonly string[], now = new Date()): Promise<FiscalSupportTotals> {
    const overviews = await Promise.all(tenantIds.map((tenantId) => this.overview(tenantId, now)))
    const certificates = overviews.flatMap((overview) => overview.certificates)
    const packages = overviews.flatMap((overview) => overview.sourcePackages)
    const sum = (read: (overview: FiscalSupportOverview) => number) =>
      overviews.reduce((total, overview) => total + read(overview), 0)
    const max = (read: (overview: FiscalSupportOverview) => number) =>
      overviews.reduce((top, overview) => Math.max(top, read(overview)), 0)
    return {
      queuePending: sum((overview) => overview.queue.pending),
      queueLeased: sum((overview) => overview.queue.leased),
      queueOldestDueSeconds: max((overview) => overview.queue.oldestDueSeconds),
      unknownOutcomes: sum((overview) => overview.unknownOutcomes),
      certificateMinDaysRemaining: certificates.length
        ? Math.min(...certificates.map((item) => item.daysRemaining))
        : null,
      certificatesExpiring: certificates.filter((item) => item.state === 'expiring').length,
      certificatesExpired: certificates.filter((item) => item.state === 'expired').length,
      importsBlocked: sum((overview) => overview.imports.blocked),
      importsOpen: sum((overview) => overview.imports.open),
      outboxUndelivered: sum((overview) => overview.outbox.undelivered),
      outboxOldestSeconds: max((overview) => overview.outbox.oldestUndeliveredSeconds),
      sourcePackageMaxAgeDays: packages.length
        ? Math.max(...packages.map((item) => item.ageDays))
        : null,
    }
  }

  /**
   * Queues a consultation for documents whose outcome is unknown and that have nothing
   * pending. The key is derived from the state, so running it twice queues nothing new.
   */
  async reconcileUnknown(
    tenantId: string,
    actorId: string,
    limit: number,
  ): Promise<SupportCommandResult> {
    z.uuid().parse(tenantId)
    actorSchema.parse(actorId)
    limitSchema.parse(limit)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const documents = await tx`select d.id, d.status,
          (select t.id from fiscal_transitions t where t.tenant_id = d.tenant_id
            and t.document_id = d.id order by t.occurred_at desc, t.id desc limit 1) as since
        from fiscal_documents d
        where d.tenant_id = ${tenantId} and d.status in ('unknown', 'cancellation_unknown')
        order by d.created_at, d.id limit ${limit} for update of d`
      const result: SupportCommandResult = {
        command: 'reconcile-unknown',
        tenantId,
        changed: [],
        skipped: [],
      }
      for (const document of documents) {
        const documentId = String(document.id)
        const [pending] = await tx`select command.id from fiscal_dispatch_commands command
          join fiscal_dispatch_jobs job on job.tenant_id = command.tenant_id
            and job.command_id = command.id
          where command.tenant_id = ${tenantId} and command.document_id = ${documentId}
            and job.state <> 'done' limit 1`
        if (pending) {
          result.skipped.push({ id: documentId, reason: 'a command is already pending' })
          continue
        }
        const cancellation = document.status === 'cancellation_unknown'
        const kind = cancellation ? 'cancellation_query' : 'status_query'
        const [original] = await tx`select id from fiscal_dispatch_commands
          where tenant_id = ${tenantId} and document_id = ${documentId}
            and kind = ${cancellation ? 'cancellation' : 'issuance'}`
        if (!original) {
          result.skipped.push({ id: documentId, reason: 'no original command to consult' })
          continue
        }
        const idempotencyKey = `support-reconcile-${documentId}-${String(document.since)}`
        const [existing] = await tx`select id from fiscal_dispatch_commands
          where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`
        if (existing) {
          result.skipped.push({ id: documentId, reason: 'already reconciled for this state' })
          continue
        }
        const commandId = randomUUID()
        await tx`insert into fiscal_dispatch_commands (
          id, tenant_id, document_id, kind, idempotency_key, request_digest, actor_id
        ) values (
          ${commandId}, ${tenantId}, ${documentId}, ${kind}, ${idempotencyKey},
          ${canonicalDigest({ documentId, command: kind })}, ${actorId}
        )`
        await tx`insert into fiscal_dispatch_jobs (tenant_id, command_id)
          values (${tenantId}, ${commandId})`
        await appendAudit(tx, {
          tenantId,
          actorId,
          action: 'support.reconcile-unknown',
          resourceId: documentId,
          detail: { commandId, kind, originalCommandId: String(original.id) },
        })
        result.changed.push({ id: documentId, detail: `${kind} ${commandId}` })
      }
      return result
    })
  }

  /** Brings forward pending jobs waiting on their backoff; a job's steps are unchanged. */
  async retryDue(tenantId: string, actorId: string, limit: number): Promise<SupportCommandResult> {
    z.uuid().parse(tenantId)
    actorSchema.parse(actorId)
    limitSchema.parse(limit)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const jobs = await tx`select job.command_id, command.document_id, job.next_attempt_at
        from fiscal_dispatch_jobs job
        join fiscal_dispatch_commands command on command.tenant_id = job.tenant_id
          and command.id = job.command_id
        where job.tenant_id = ${tenantId} and job.state = 'pending'
          and job.next_attempt_at > now()
        order by job.next_attempt_at, job.command_id limit ${limit} for update of job`
      const result: SupportCommandResult = {
        command: 'retry-due',
        tenantId,
        changed: [],
        skipped: [],
      }
      for (const job of jobs) {
        await tx`update fiscal_dispatch_jobs set next_attempt_at = now(), updated_at = now()
          where tenant_id = ${tenantId} and command_id = ${job.command_id}
            and state = 'pending'`
        await appendAudit(tx, {
          tenantId,
          actorId,
          action: 'support.retry-due',
          resourceId: String(job.document_id),
          detail: { commandId: String(job.command_id), was: instant(job.next_attempt_at) },
        })
        result.changed.push({
          id: String(job.command_id),
          detail: `document ${String(job.document_id)} was due ${instant(job.next_attempt_at)}`,
        })
      }
      return result
    })
  }

  /**
   * Asks the relay to publish delivered events again, under their own event ids. Consumers
   * already deduplicate by event id, so a replay can refresh a projection but never
   * repeat a stock or money effect.
   */
  async replayOutbox(
    tenantId: string,
    actorId: string,
    input: { reason: string; limit: number; documentId?: string; eventIds?: string[] },
  ): Promise<SupportCommandResult> {
    z.uuid().parse(tenantId)
    actorSchema.parse(actorId)
    const reason = reasonSchema.parse(input.reason)
    limitSchema.parse(input.limit)
    const documentId = input.documentId ? z.uuid().parse(input.documentId) : null
    const eventIds = input.eventIds
      ? z.array(z.uuid()).max(SUPPORT_COMMAND_LIMIT).parse(input.eventIds)
      : null
    if (!documentId && !eventIds?.length)
      throw new Error('Replay needs a document or explicit event ids')
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const events = await tx`select event_id, event_type, delivered_at from fiscal_outbox
        where tenant_id = ${tenantId}
          and (${documentId}::text is null or payload->>'documentId' = ${documentId}::text)
          and (${eventIds ?? null}::uuid[] is null or event_id = any(${eventIds ?? null}::uuid[]))
        order by created_at, event_id limit ${input.limit}`
      const result: SupportCommandResult = {
        command: 'replay-outbox',
        tenantId,
        changed: [],
        skipped: [],
      }
      for (const event of events) {
        const eventId = String(event.event_id)
        if (!event.delivered_at) {
          result.skipped.push({ id: eventId, reason: 'not delivered yet; the relay sends it' })
          continue
        }
        const [pending] = await tx`select id from fiscal_outbox_replays
          where tenant_id = ${tenantId} and event_id = ${eventId} and delivered_at is null`
        if (pending) {
          result.skipped.push({ id: eventId, reason: 'a replay is already pending' })
          continue
        }
        const replayId = randomUUID()
        await tx`insert into fiscal_outbox_replays (id, tenant_id, event_id, requested_by, reason)
          values (${replayId}, ${tenantId}, ${eventId}, ${actorId}, ${reason})`
        await appendAudit(tx, {
          tenantId,
          actorId,
          action: 'support.replay-outbox',
          resourceId: eventId,
          detail: { replayId, eventType: String(event.event_type), reason },
        })
        result.changed.push({ id: eventId, detail: String(event.event_type) })
      }
      return result
    })
  }
}

function certificate(row: postgres.Row, now: Date) {
  const validUntil = new Date(row.valid_until)
  const daysRemaining = Math.floor((validUntil.getTime() - now.getTime()) / (DAY_SECONDS * 1000))
  return {
    establishmentId: String(row.establishment_id),
    fingerprint: String(row.fingerprint),
    validUntil: validUntil.toISOString(),
    daysRemaining,
    state: certificateState(validUntil, now),
  }
}

export function certificateState(validUntil: Date, now: Date): 'valid' | 'expiring' | 'expired' {
  const remaining = validUntil.getTime() - now.getTime()
  if (remaining <= 0) return 'expired'
  return remaining <= CERTIFICATE_WARNING_DAYS * DAY_SECONDS * 1000 ? 'expiring' : 'valid'
}

function seconds(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

function instant(value: unknown): string {
  return new Date(value as string).toISOString()
}

function date(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}
