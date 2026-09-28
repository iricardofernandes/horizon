import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { ServiceContract } from '@/domain/entities/service-contract'
import { BillingRunFinishedEvent } from '@/domain/events/sales-events'
import {
  type BillingRun,
  CREDIT_REASONS,
  type CreditReason,
  competenceStart,
  isCompetence,
  type RefusalReason,
  type RunItem,
  type SkipReason,
  skipMessage,
} from '@/domain/services/contract-billing'
import { addMonths, type SchedulePeriod } from '@/domain/services/contract-schedule'
import { BusinessDate, Reason } from '@/domain/value-objects/sales-values'
import { type BillingMetrics, NO_BILLING_METRICS } from '../ports/billing-metrics'
import type { Clock } from '../ports/clock'
import type { SalesScope, SalesUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'
import type { RenewDueContractsUseCase } from './service-contracts'

/** How many pending contracts a run reads at a time while it processes. */
const PAGE = 50

type Decision =
  | { readonly outcome: 'billed'; readonly period: SchedulePeriod }
  | { readonly outcome: 'skipped'; readonly reason: SkipReason; readonly period: SchedulePeriod }
  | {
      readonly outcome: 'refused'
      readonly reason: RefusalReason
      readonly period: SchedulePeriod
    }

const REFUSAL_MESSAGES: Readonly<Record<RefusalReason, string>> = {
  'customer-inactive': 'the customer is no longer active',
  'service-unavailable': 'a service of this contract is no longer offered in the Catalog',
}

/**
 * What billing would do to a contract's period of `competence` on `today`, or null when
 * no period of the contract starts that month. The schedule says whether the period is
 * due; the customer and the Catalog say whether it can be billed now.
 */
export async function decisionFor(
  scope: SalesScope,
  contract: ServiceContract,
  competence: string,
  today: BusinessDate,
): Promise<Decision | null> {
  const billing = contract.billingFor(competence, today)
  if (!billing) return null
  const { period } = billing
  if (billing.kind === 'skip') return { outcome: 'skipped', reason: billing.reason, period }
  const customer = await scope.customers.findById(contract.customerId)
  if (!customer?.isActive()) return { outcome: 'refused', reason: 'customer-inactive', period }
  const revision = contract.revisionNumbered(period.revision)
  for (const line of revision?.lines ?? []) {
    const item = await scope.catalogItems.findById(line.itemId)
    if (!item?.active) return { outcome: 'refused', reason: 'service-unavailable', period }
  }
  return { outcome: 'billed', period }
}

/** The days of a competence month that has begun by `today`. */
function monthOf(
  competence: string,
  today: BusinessDate,
): Either<InvalidInputError | ConflictError, { from: BusinessDate; to: BusinessDate }> {
  if (!isCompetence(competence))
    return left(new InvalidInputError('/competence', 'a competence month is YYYY-MM'))
  const from = competenceStart(competence)
  if (today.isBefore(from)) return left(new ConflictError(`${competence} has not begun yet`))
  return right({ from, to: addMonths(from, 1).plusDays(-1) })
}

function billPeriod(
  contract: ServiceContract,
  input: { competence: string; today: BusinessDate; actor: string; runId: string | null },
  now: Date,
) {
  return contract.bill(
    {
      ...input,
      billedPeriodId: new UniqueEntityID().toString(),
      entryId: () => new UniqueEntityID().toString(),
    },
    now,
  )
}

/** A person bills one period of one contract, outside any run. */
export class BillPeriodUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    contractId: string
    competence: string
  }): Outcome<{ contractId: string; billedPeriodId: string; competence: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'contract.bill-period', request, async (scope) => {
      const now = this.clock.now()
      const today = BusinessDate.of(now)
      const month = monthOf(request.competence, today)
      if (month.isLeft()) return left(month.value)
      const contract = await scope.contracts.findById(request.contractId)
      if (!contract) return left(new ResourceNotFoundError('contract was not found'))
      const decision = await decisionFor(scope, contract, request.competence, today)
      if (!decision)
        return left(new ConflictError(`the contract has no period in ${request.competence}`))
      if (decision.outcome === 'skipped')
        return left(new ConflictError(skipMessage(decision.reason)))
      if (decision.outcome === 'refused')
        return left(new ConflictError(REFUSAL_MESSAGES[decision.reason]))
      const billed = billPeriod(
        contract,
        { competence: request.competence, today, actor: context.actor, runId: null },
        now,
      )
      if (billed.isLeft()) return left(billed.value)
      await scope.contracts.save(contract)
      await recordBilled(scope, context, contract, billed.value.id, request.competence, now)
      return right({
        contractId: request.contractId,
        billedPeriodId: billed.value.id,
        competence: request.competence,
      })
    })
  }
}

/** A billed period is credited in full; it stays, marked credited. */
export class CreditPeriodUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    contractId: string
    competence: string
    reasonCode: string
    reason: string
  }): Outcome<{ contractId: string; billedPeriodId: string; competence: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'contract.credit-period', request, async (scope) => {
      if (!(CREDIT_REASONS as readonly string[]).includes(request.reasonCode))
        return left(new InvalidInputError('/reasonCode', 'not-provided or billing-error'))
      const reason = Reason.create(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const contract = await scope.contracts.findById(request.contractId)
      if (!contract) return left(new ResourceNotFoundError('contract was not found'))
      const now = this.clock.now()
      const credited = contract.credit(
        {
          today: BusinessDate.of(now),
          actor: context.actor,
          competence: request.competence,
          reasonCode: request.reasonCode as CreditReason,
          reason: reason.value,
        },
        now,
      )
      if (credited.isLeft()) return left(credited.value)
      await scope.contracts.save(contract)
      await audit(scope, context, {
        action: 'contract.period-credited',
        subjectType: 'contract',
        subjectId: request.contractId,
        occurredAt: now,
        details: {
          billedPeriodId: credited.value.id,
          competence: request.competence,
          reasonCode: request.reasonCode,
          reason: request.reason,
        },
      })
      return right({
        contractId: request.contractId,
        billedPeriodId: credited.value.id,
        competence: request.competence,
      })
    })
  }
}

export interface PreviewItem {
  readonly contractId: string
  readonly customerId: string
  readonly outcome: 'billed' | 'skipped' | 'refused'
  readonly reason: SkipReason | RefusalReason | null
  readonly revision: number
  readonly billingOn: string
  readonly amount: { readonly amount: string; readonly currency: string }
}

/** What a run for a competence month would do to every contract, writing nothing. */
export class PreviewBillingRunUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    context: CommandContext,
    competence: string,
  ): Promise<Either<Failure, { competence: string; items: readonly PreviewItem[] }>> {
    const today = BusinessDate.of(this.clock.now())
    const month = monthOf(competence, today)
    if (month.isLeft()) return left(month.value)
    const items = await this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const found: PreviewItem[] = []
      for (const contractId of await scope.contracts.inForce(
        month.value.from.value,
        month.value.to.value,
      )) {
        const contract = await scope.contracts.read(contractId)
        const decision = contract && (await decisionFor(scope, contract, competence, today))
        if (!contract || !decision) continue
        found.push({
          contractId,
          customerId: contract.customerId,
          outcome: decision.outcome,
          reason: decision.outcome === 'billed' ? null : decision.reason,
          revision: decision.period.revision,
          billingOn: decision.period.billingOn.value,
          amount: {
            amount: decision.period.amount.amount.toString(),
            currency: decision.period.amount.currency.value,
          },
        })
      }
      return found
    })
    return right({ competence, items })
  }
}

/**
 * Processes a run's pending contracts, one transaction each, under the contract's lock.
 *
 * Each contract is classified again when its turn comes, so what changed since the run
 * started is respected. A run stopped midway keeps its pending items, and processing it
 * again finishes them: the unique `(contract, competence)` of a billed period makes a
 * second bill impossible whatever happens in between.
 */
export class ProcessBillingRunUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
    private readonly metrics: BillingMetrics = NO_BILLING_METRICS,
  ) {}

  async execute(
    context: CommandContext,
    runId: string,
    options: { limit?: number } = {},
  ): Promise<Either<ResourceNotFoundError, BillingRun>> {
    const run = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.billingRuns.findById(runId),
    )
    if (!run) return left(new ResourceNotFoundError('billing run was not found'))
    let budget = options.limit ?? Number.POSITIVE_INFINITY
    while (run.status === 'running' && budget > 0) {
      const pending = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
        scope.billingRuns.pending(runId, Math.min(PAGE, budget)),
      )
      if (pending.length === 0) break
      for (const contractId of pending) {
        await this.unitOfWork.inTenant(context.tenantId, (scope) =>
          this.decideOne(scope, context, run, contractId),
        )
        budget -= 1
      }
    }
    await this.close(context, run)
    const current = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.billingRuns.findById(runId),
    )
    return current ? right(current) : left(new ResourceNotFoundError('billing run was not found'))
  }

  private async decideOne(
    scope: SalesScope,
    context: CommandContext,
    run: BillingRun,
    contractId: string,
  ): Promise<void> {
    if (!(await scope.billingRuns.claim(run.id, contractId))) return
    const now = this.clock.now()
    const today = BusinessDate.of(now)
    const contract = await scope.contracts.findById(contractId)
    const decision = contract && (await decisionFor(scope, contract, run.competence, today))
    if (!contract || !decision) {
      await scope.billingRuns.decide(
        run.id,
        contractId,
        { outcome: 'skipped', reason: 'nothing-to-bill', billedPeriodId: null },
        now,
      )
      return
    }
    if (decision.outcome !== 'billed') {
      await scope.billingRuns.decide(
        run.id,
        contractId,
        { outcome: decision.outcome, reason: decision.reason, billedPeriodId: null },
        now,
      )
      return
    }
    const billed = billPeriod(
      contract,
      { competence: run.competence, today, actor: run.requestedBy, runId: run.id },
      now,
    )
    // The decision above came from the same state under the same lock.
    if (billed.isLeft()) throw billed.value
    await scope.contracts.save(contract)
    await recordBilled(
      scope,
      { ...context, actor: run.requestedBy },
      contract,
      billed.value.id,
      run.competence,
      now,
    )
    await scope.billingRuns.decide(
      run.id,
      contractId,
      { outcome: 'billed', reason: null, billedPeriodId: billed.value.id },
      now,
    )
  }

  /** Closes the run once nothing is pending, and reports it exactly once. */
  private async close(context: CommandContext, run: BillingRun): Promise<void> {
    const now = this.clock.now()
    const closed = await this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      if (!(await scope.billingRuns.complete(run.id, now))) return null
      await audit(scope, context, {
        action: 'billing-run.completed',
        subjectType: 'billing-run',
        subjectId: run.id,
        occurredAt: now,
        details: { competence: run.competence },
      })
      const finished = await scope.billingRuns.findById(run.id)
      if (finished) await scope.events.append(finishedEvent(context.tenantId, finished, now))
      return finished
    })
    if (!closed) return
    for (const item of closed.items)
      if (item.outcome !== 'pending') this.metrics.decided(item.outcome, item.reason)
    this.metrics.runFinished((now.getTime() - closed.startedAt.getTime()) / 1000)
  }
}

/**
 * Starts the billing run of a competence month under an idempotency key.
 *
 * Self-renewing contracts are renewed first, so a contract in its last period does not
 * miss the next one. The run and an item per candidate contract are recorded in one
 * transaction: what the schedule or the customer already rules out is decided there, and
 * the rest is billed contract by contract. The same key finds the same run and carries on
 * with whatever is still pending.
 */
export class StartBillingRunUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
    private readonly renewals: Pick<RenewDueContractsUseCase, 'execute'>,
    private readonly processing: Pick<ProcessBillingRunUseCase, 'execute'>,
  ) {}

  async execute(request: {
    context: IdempotentContext
    competence: string
  }): Promise<Either<Failure, BillingRun>> {
    const { context } = request
    const month = monthOf(request.competence, BusinessDate.of(this.clock.now()))
    if (month.isLeft()) return left(month.value)
    await this.renewals.execute(context)
    const started = await once(
      this.unitOfWork,
      context,
      'billing-run.start',
      request,
      async (scope) => {
        const now = this.clock.now()
        const run: BillingRun = {
          id: new UniqueEntityID().toString(),
          competence: request.competence,
          status: 'running',
          requestedBy: context.actor,
          startedAt: now,
          finishedAt: null,
          items: await this.candidates(scope, request.competence, month.value, now),
        }
        await scope.billingRuns.create(run)
        await audit(scope, context, {
          action: 'billing-run.started',
          subjectType: 'billing-run',
          subjectId: run.id,
          occurredAt: now,
          details: { competence: run.competence, contracts: run.items.length },
        })
        return right({ runId: run.id })
      },
    )
    if (started.isLeft()) return left(started.value)
    return this.processing.execute(context, started.value.runId)
  }

  private async candidates(
    scope: SalesScope,
    competence: string,
    month: { from: BusinessDate; to: BusinessDate },
    now: Date,
  ): Promise<readonly RunItem[]> {
    const today = BusinessDate.of(now)
    const items: RunItem[] = []
    for (const contractId of await scope.contracts.inForce(month.from.value, month.to.value)) {
      const contract = await scope.contracts.read(contractId)
      const decision = contract && (await decisionFor(scope, contract, competence, today))
      if (!contract || !decision) continue
      const decided = decision.outcome !== 'billed'
      items.push({
        contractId,
        customerId: contract.customerId,
        outcome: decided ? decision.outcome : 'pending',
        reason: decided ? decision.reason : null,
        billedPeriodId: null,
        decidedAt: decided ? now : null,
      })
    }
    return items
  }
}

async function recordBilled(
  scope: SalesScope,
  context: CommandContext,
  contract: ServiceContract,
  billedPeriodId: string,
  competence: string,
  now: Date,
): Promise<void> {
  await audit(scope, context, {
    action: 'contract.period-billed',
    subjectType: 'contract',
    subjectId: contract.id.toString(),
    occurredAt: now,
    details: { billedPeriodId, competence },
  })
}

/** Tells whoever started the run how it ended (Phase 66). */
function finishedEvent(tenantId: string, run: BillingRun, now: Date): BillingRunFinishedEvent {
  const count = (outcome: string) => run.items.filter((item) => item.outcome === outcome).length
  return new BillingRunFinishedEvent(new UniqueEntityID(run.id), tenantId, now, {
    competence: run.competence,
    startedBy: run.requestedBy,
    billed: count('billed'),
    skipped: count('skipped'),
    refused: count('refused'),
  })
}
