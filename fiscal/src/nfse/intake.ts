import {
  businessDayOf,
  type FiscalServiceIntake,
  fiscalServiceIntakeSchema,
  type fiscalServiceIntakeStatusSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from '../audit'
import type { FiscalCapabilities } from '../capabilities'
import type { FiscalProjections } from '../projections'
import type { FiscalServiceCancellation } from './cancellation'
import type { FiscalServiceDocuments } from './documents'
import { ServiceCancellationWindowElapsed } from './errors'
import type { FiscalServiceIssuance } from './issuance'
import type { FiscalServiceIssuancePolicies } from './issuance-policies'
import type { FiscalServiceReadiness } from './readiness'
import { localDate } from './readiness'
import { type FiscalServiceOrigins, NFSE_OPERATION } from './service-origins'
import type { FiscalServiceProfiles } from './service-profiles'

type Status = z.infer<typeof fiscalServiceIntakeStatusSchema>
type Row = Record<string, unknown>

/** What one step decided: the next status and what it learned on the way. */
type Step = {
  status: Status
  reason?: string | null
  establishmentId?: string
  serviceOriginId?: string
  documentId?: string
  /** Seconds until the worker looks again; null when nothing is left for it to do. */
  retryIn?: number | null
  failed?: boolean
}

const ACTOR = 'fiscal:service-intake'
/** A claimed intake is not picked again while its step runs. */
const LEASE_SECONDS = 120
/** How long to wait for a transmission in flight before looking again. */
const IN_FLIGHT_SECONDS = 30
const MAX_BACKOFF_SECONDS = 3600

export type IntakeDependencies = {
  projections: Pick<FiscalProjections, 'resolveIssuer' | 'resolveParty'>
  capabilities: Pick<FiscalCapabilities, 'listActive'>
  profiles: Pick<FiscalServiceProfiles, 'effective'>
  origins: Pick<FiscalServiceOrigins, 'create'>
  documents: Pick<FiscalServiceDocuments, 'createDraft' | 'get'>
  readiness: Pick<FiscalServiceReadiness, 'validate'>
  policies: Pick<FiscalServiceIssuancePolicies, 'read'>
  issuance?: Pick<FiscalServiceIssuance, 'issue'>
  cancellation?: Pick<FiscalServiceCancellation, 'request'>
}

/**
 * Turns services delivered in Sales into NFS-e (Phase 50, ADR 0056).
 *
 * Each delivered line becomes one service origin, keyed by `sales` / `service-delivery` /
 * its entry id / its competence month, and one draft. Under `automatic` the draft is
 * validated and issued; under `review` it waits for a person. Anything that stops the way
 * — a missing service profile, an unsupported municipality, an incomplete recipient —
 * leaves the intake blocked with the reason, and the worker tries again later.
 *
 * A cancelled delivery is undone the same way: an authorized NFS-e gets event 101101
 * ("service not provided"), a draft is withdrawn and can no longer be issued, and a
 * transmission in flight is waited for.
 */
export class FiscalServiceIntakes {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly dependencies: IntakeDependencies,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#db = postgres(databaseUrl, { max: 3, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async list(
    tenantId: string,
    filter: {
      status?: Status | undefined
      documentType?: 'service-delivery' | 'contract-period' | undefined
      period?: string | undefined
      limit?: number
    } = {},
  ): Promise<FiscalServiceIntake[]> {
    z.uuid().parse(tenantId)
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const rows = await this.inTenant(
      tenantId,
      (tx) => tx`select * from fiscal_service_intakes where tenant_id = ${tenantId}
        ${filter.status ? tx`and status = ${filter.status}` : tx``}
        ${filter.documentType ? tx`and source_document_type = ${filter.documentType}` : tx``}
        ${filter.period ? tx`and period = ${filter.period}` : tx``}
        order by created_at desc, id desc limit ${limit}`,
    )
    return rows.map(readIntake)
  }

  /** An operator fixed what blocked an intake and asks for it to be tried now. */
  async retry(tenantId: string, intakeId: string, actorId: string): Promise<FiscalServiceIntake> {
    z.uuid().parse(intakeId)
    const [row] = await this.inTenant(tenantId, async (tx) => {
      const updated = await tx`update fiscal_service_intakes
        set next_attempt_at = now(), updated_at = now()
        where tenant_id = ${tenantId} and id = ${intakeId} and status = 'blocked'
        returning *`
      if (updated.length > 0)
        await appendAudit(tx, {
          tenantId,
          actorId,
          action: 'service-intake.retry-requested',
          resourceId: intakeId,
          detail: null,
        })
      return updated
    })
    if (!row) throw new Error('Fiscal service intake is not blocked')
    return readIntake(row)
  }

  /** Advances the oldest due intake of the tenant by one step; false when none is due. */
  async processOne(tenantId: string): Promise<boolean> {
    const intake = await this.claim(tenantId)
    if (!intake) return false
    let step: Step
    try {
      step = intake.withdrawal_requested
        ? await this.withdraw(tenantId, intake)
        : await this.advance(tenantId, intake)
    } catch (error) {
      // Forward, anything unexpected blocks the intake with its reason; while undoing, the
      // intake keeps where it was and the worker simply tries again later.
      step = intake.withdrawal_requested
        ? { status: intake.status as Status, reason: messageOf(error), failed: true }
        : { ...blocked(messageOf(error)), failed: true }
    }
    await this.record(tenantId, intake, step)
    return true
  }

  /** Leases the oldest due intake, so a concurrent worker leaves it alone meanwhile. */
  private async claim(tenantId: string): Promise<Row | null> {
    const [row] = await this.inTenant(
      tenantId,
      (tx) => tx`update fiscal_service_intakes set
          next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
        where tenant_id = ${tenantId} and id = (
          select id from fiscal_service_intakes
          where tenant_id = ${tenantId} and next_attempt_at <= now()
            and status not in ('withdrawn', 'cancellation-refused')
          order by next_attempt_at, created_at
          limit 1 for update skip locked)
        returning *`,
    )
    return row ?? null
  }

  /** One step forward: origin, then draft, then (automatic) validation and issuance. */
  private async advance(tenantId: string, intake: Row): Promise<Step> {
    const { dependencies } = this
    if (intake.currency !== 'BRL')
      return blocked('Only services billed in BRL are issued as a national NFS-e')
    let establishmentId = intake.establishment_id ? String(intake.establishment_id) : null
    let serviceOriginId = intake.service_origin_id ? String(intake.service_origin_id) : null
    if (!serviceOriginId) {
      const resolved = await this.resolve(tenantId, intake)
      if ('reason' in resolved) return blocked(resolved.reason)
      establishmentId = resolved.establishmentId
      const origin = await dependencies.origins.create({
        tenantId,
        idempotencyKey: `sales-service-${intake.entry_id}`,
        actorId: ACTOR,
        request: {
          establishmentId,
          issuerProfileRevision: resolved.issuerRevision,
          recipientPartyId: String(intake.customer_id),
          recipientProfileRevision: resolved.recipientRevision,
          serviceItemId: String(intake.service_item_id),
          serviceProfileRevision: resolved.profileRevision,
          competenceDate: dateOf(intake.competence_date),
          amount: { amount: String(intake.amount_minor), currency: 'BRL' },
          description: String(intake.description),
          reason: originReason(intake),
          sourceKey: {
            module: 'sales',
            documentType: String(intake.source_document_type),
            id: String(intake.entry_id),
            period: String(intake.period),
          },
        },
      })
      serviceOriginId = origin.id
    }
    if (!establishmentId) return blocked('The service origin has no establishment')
    const policy = await dependencies.policies.read(tenantId, establishmentId)
    let documentId = intake.document_id ? String(intake.document_id) : null
    if (!documentId) {
      const draft = await dependencies.documents.createDraft({
        tenantId,
        serviceOriginId,
        establishmentId,
        series: policy.series,
        idempotencyKey: `sales-service-draft-${intake.entry_id}`,
        actorId: ACTOR,
      })
      documentId = draft.id
    }
    const progress = { establishmentId, serviceOriginId, documentId }
    if (policy.mode === 'review') return { status: 'drafted', ...progress, retryIn: null }
    if (!dependencies.issuance)
      return { ...blocked('The national NFS-e flow is not configured'), ...progress }
    const ready = await dependencies.readiness.validate({ tenantId, documentId, actorId: ACTOR })
    if (!ready.supported) return { ...blocked(`${ready.code}: ${ready.detail}`), ...progress }
    await dependencies.issuance.issue({
      tenantId,
      documentId,
      idempotencyKey: `sales-service-issue-${intake.entry_id}`,
      actorId: ACTOR,
    })
    return { status: 'issuing', ...progress, retryIn: null }
  }

  /** What the origin needs, as it stands on the day it is issued. */
  private async resolve(
    tenantId: string,
    intake: Row,
  ): Promise<
    | {
        establishmentId: string
        issuerRevision: number
        recipientRevision: number
        profileRevision: number
      }
    | { reason: string }
  > {
    const { projections, capabilities, profiles } = this.dependencies
    const probe = await projections.resolveIssuer(tenantId, businessDayOf(this.now()))
    if (!probe) return { reason: 'The issuer fiscal profile has not reached Fiscal yet' }
    const issueDate = localDate(this.now(), probe.timezone)
    const issuer = await projections.resolveIssuer(tenantId, issueDate)
    if (!issuer) return { reason: 'No issuer fiscal profile is in force today' }
    // Work delivered "today" in UTC can still be tomorrow for the issuer: the NFS-e waits
    // for its competence day to begin where it is issued (E0015).
    const competenceDate = dateOf(intake.competence_date)
    if (competenceDate > issueDate)
      return {
        reason: `The competence date ${competenceDate} has not begun in ${probe.timezone} yet (E0015); it is issued from that day on`,
      }
    const municipalityCode = issuer.company.address.municipalityCode
    const establishments = [
      ...new Set(
        (await capabilities.listActive(tenantId))
          .filter(
            (row) =>
              row.model === 'nfse' &&
              row.environment === 'simulation' &&
              row.jurisdictionKind === 'municipality' &&
              row.jurisdictionCode === municipalityCode &&
              row.operation === NFSE_OPERATION,
          )
          .map((row) => row.establishmentId),
      ),
    ]
    const [establishmentId] = establishments
    if (!establishmentId)
      return { reason: `No establishment issues NFS-e in municipality ${municipalityCode}` }
    if (establishments.length > 1)
      return {
        reason: `More than one establishment issues NFS-e in municipality ${municipalityCode}`,
      }
    const recipient = await projections.resolveParty(
      tenantId,
      String(intake.customer_id),
      issueDate,
    )
    if (!recipient) return { reason: 'The customer fiscal profile has not reached Fiscal yet' }
    const profile = await profiles.effective(
      tenantId,
      String(intake.service_item_id),
      competenceDate,
    )
    if (!profile)
      return {
        reason:
          'SERVICE_PROFILE_MISSING: no service fiscal profile is in force at the competence date',
      }
    return {
      establishmentId,
      issuerRevision: issuer.revision,
      recipientRevision: recipient.revision,
      profileRevision: profile.revision,
    }
  }

  /** Undo the NFS-e of a cancelled delivery or a credited period, or say why it cannot be. */
  private async withdraw(tenantId: string, intake: Row): Promise<Step> {
    if (!intake.document_id) return withdrawn('The service was withdrawn in Sales before any NFS-e')
    const documentId = String(intake.document_id)
    const document = await this.dependencies.documents.get(tenantId, documentId)
    if (!document) throw new Error('Fiscal document not found')
    switch (document.status) {
      case 'draft':
      case 'ready':
        return withdrawn('The draft was withdrawn: the service was withdrawn before issuance')
      case 'rejected':
      case 'cancelled':
        return withdrawn(`The NFS-e is ${document.status}; nothing is left to undo`)
      case 'authorized':
        break
      default:
        return { status: 'cancelling', retryIn: IN_FLIGHT_SECONDS }
    }
    if (intake.status === 'cancelling') return { status: 'cancelling', retryIn: IN_FLIGHT_SECONDS }
    if (!this.dependencies.cancellation)
      return {
        status: 'cancellation-refused',
        reason: 'The national NFS-e cancellation is not configured',
        retryIn: null,
      }
    try {
      await this.dependencies.cancellation.request({
        tenantId,
        documentId,
        idempotencyKey: `sales-service-cancel-${intake.entry_id}`,
        actorId: ACTOR,
        ...cancellationOf(intake),
      })
    } catch (error) {
      if (error instanceof ServiceCancellationWindowElapsed)
        return { status: 'cancellation-refused', reason: error.message, retryIn: null }
      throw error
    }
    return { status: 'cancelling', retryIn: IN_FLIGHT_SECONDS }
  }

  private async record(tenantId: string, intake: Row, step: Step): Promise<void> {
    const attempts = Number(intake.attempts) + (step.failed || step.status === 'blocked' ? 1 : 0)
    const retryIn =
      step.retryIn !== undefined
        ? step.retryIn
        : Math.min(60 * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_SECONDS)
    // A withdrawal that arrived while this step ran is due now, whatever the step said.
    await this.inTenant(tenantId, async (tx) => {
      await tx`update fiscal_service_intakes set
          status = ${step.status},
          reason = ${step.reason ?? null},
          attempts = ${attempts},
          next_attempt_at = case
            when withdrawal_requested and ${!intake.withdrawal_requested} then now()
            else ${retryIn === null ? null : tx`now() + make_interval(secs => ${retryIn})`}
          end,
          establishment_id = coalesce(establishment_id, ${step.establishmentId ?? null}::uuid),
          service_origin_id = coalesce(service_origin_id, ${step.serviceOriginId ?? null}::uuid),
          document_id = coalesce(document_id, ${step.documentId ?? null}::uuid),
          updated_at = now()
        where tenant_id = ${tenantId} and id = ${String(intake.id)}`
      if (step.status !== intake.status)
        await appendAudit(tx, {
          tenantId,
          actorId: ACTOR,
          action: `service-intake.${step.status}`,
          resourceId: String(intake.id),
          detail: {
            entryId: intake.entry_id,
            documentId: step.documentId ?? intake.document_id ?? null,
            reason: step.reason ?? null,
          },
        })
    })
  }

  private inTenant<T>(tenantId: string, work: (tx: postgres.TransactionSql) => Promise<T>) {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return work(tx)
    }) as Promise<T>
  }
}

/** What the origin says about where it came from in Sales. */
function originReason(intake: Row): string {
  if (intake.source_document_type === 'contract-period')
    return `Período ${intake.period} do contrato ${intake.contract_id} faturado no Sales`
  return `Serviço entregue no Sales (entrega ${intake.delivery_id})`
}

/** The 101101 reason a withdrawal asked for: 2, not provided (the default), or 1, in error. */
function cancellationOf(intake: Row): { reasonCode: '1' | '2'; reason: string } {
  const text = String(intake.withdrawal_reason)
  if (intake.withdrawal_code === '1')
    return { reasonCode: '1', reason: `Erro na emissão: ${text}`.slice(0, 255) }
  return { reasonCode: '2', reason: `Serviço não prestado: ${text}`.slice(0, 255) }
}

function blocked(reason: string): Step {
  return { status: 'blocked', reason: reason.slice(0, 1000) }
}

function withdrawn(reason: string): Step {
  return { status: 'withdrawn', reason, retryIn: null }
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected failure'
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return (
    typeof code === 'string' && /^[A-Z_]+$/.test(code) ? `${code}: ${message}` : message
  ).slice(0, 1000)
}

function dateOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function readIntake(row: Row): FiscalServiceIntake {
  const instant = (value: unknown) => (value ? new Date(String(value)).toISOString() : null)
  return fiscalServiceIntakeSchema.parse({
    id: row.id,
    sourceKey: {
      module: row.source_module,
      documentType: row.source_document_type,
      id: row.entry_id,
      period: row.period,
    },
    deliveryId: row.delivery_id ?? null,
    serviceOrderId: row.service_order_id ?? null,
    billedPeriodId: row.billed_period_id ?? null,
    contractId: row.contract_id ?? null,
    customerId: row.customer_id,
    serviceItemId: row.service_item_id,
    competenceDate: dateOf(row.competence_date),
    amount: { amount: String(row.amount_minor), currency: row.currency },
    status: row.status,
    reason: row.reason ?? null,
    attempts: Number(row.attempts),
    nextAttemptAt: instant(row.next_attempt_at),
    withdrawalRequested: row.withdrawal_requested,
    serviceOriginId: row.service_origin_id ?? null,
    documentId: row.document_id ?? null,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  })
}
