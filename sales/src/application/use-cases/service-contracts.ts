import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { ServiceContract } from '@/domain/entities/service-contract'
import type { ContractLine, Recurrence } from '@/domain/services/contract-schedule'
import { BusinessDate, Money, PaymentTerms, Reason } from '@/domain/value-objects/sales-values'
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
import { priceLines } from './manage-quotes'
import { servicesOnly } from './service-orders'

const RENEWAL_ACTOR = 'system:contract-renewal'

export interface ContractLineInput {
  readonly lineId: string
  readonly itemId: string
  readonly quantity: string
  /** A negotiated price in minor units; the Catalog price when absent. */
  readonly unitPrice?: string | undefined
}

export interface ContractRequest {
  readonly customerId: string
  readonly lines: readonly ContractLineInput[]
  readonly recurrence: Recurrence
  readonly startsOn: string
  readonly endsOn?: string | undefined
  readonly billingDay: number
  readonly autoRenew?: boolean | undefined
  readonly paymentTermDays?: readonly number[] | undefined
  readonly sellerId?: string | undefined
  readonly notes?: string | undefined
}

/** Write a draft contract: services only, priced from the Catalog unless negotiated. */
export class CreateContractUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    request: ContractRequest & { context: IdempotentContext },
  ): Outcome<{ contractId: string }> {
    const { context } = request
    return once(this.unitOfWork, context, 'contract.create', request, async (scope) => {
      const terms = await termsOfContract(scope, request)
      if (terms.isLeft()) return left(terms.value)
      const { lines, dates, paymentTerms, currency } = terms.value
      const now = this.clock.now()
      const contract = ServiceContract.draft({
        tenantId: context.tenantId,
        customerId: request.customerId,
        currency,
        lines,
        recurrence: request.recurrence,
        startsOn: dates.startsOn,
        endsOn: dates.endsOn,
        billingDay: request.billingDay,
        autoRenew: request.autoRenew ?? false,
        paymentTerms,
        sellerId: request.sellerId ?? null,
        notes: request.notes ?? null,
        createdBy: context.actor,
        now,
      })
      if (contract.isLeft()) return left(contract.value)
      await scope.contracts.create(contract.value)
      await audit(scope, context, {
        action: 'contract.drafted',
        subjectType: 'contract',
        subjectId: contract.value.id.toString(),
        occurredAt: now,
        details: { customerId: request.customerId, lines: lines.length },
      })
      return right({ contractId: contract.value.id.toString() })
    })
  }
}

/** A revision from a period that has not begun: new lines, quantities, prices or recurrence. */
export class AmendContractUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    contractId: string
    effectiveFrom: string
    lines: readonly ContractLineInput[]
    recurrence: Recurrence
    reason: string
  }): Outcome<{ contractId: string; revision: number }> {
    const { context } = request
    return once(this.unitOfWork, context, 'contract.amend', request, async (scope) => {
      const contract = await scope.contracts.findById(request.contractId)
      if (!contract) return left(new ResourceNotFoundError('contract was not found'))
      const lines = await contractLines(scope, request.lines)
      if (lines.isLeft()) return left(lines.value)
      const effectiveFrom = BusinessDate.create(request.effectiveFrom, '/effectiveFrom')
      if (effectiveFrom.isLeft()) return left(effectiveFrom.value)
      const reason = Reason.create(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const now = this.clock.now()
      const revision = contract.amend(
        {
          today: BusinessDate.of(now),
          actor: context.actor,
          effectiveFrom: effectiveFrom.value,
          lines: lines.value,
          recurrence: request.recurrence,
          reason: reason.value,
        },
        now,
      )
      if (revision.isLeft()) return left(revision.value)
      await scope.contracts.save(contract)
      await audit(scope, context, {
        action: 'contract.amended',
        subjectType: 'contract',
        subjectId: request.contractId,
        occurredAt: now,
        details: {
          revision: revision.value.number,
          effectiveFrom: request.effectiveFrom,
          reason: request.reason,
        },
      })
      return right({ contractId: request.contractId, revision: revision.value.number })
    })
  }
}

/** A person renews a contract for its term, with an optional readjustment. */
export class RenewContractUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    contractId: string
    readjustmentBasisPoints?: number | undefined
    reason: string
  }): Outcome<{ contractId: string; revision: number; endsOn: string | null }> {
    const { context } = request
    return once(this.unitOfWork, context, 'contract.renew', request, async (scope) => {
      const contract = await scope.contracts.findById(request.contractId)
      if (!contract) return left(new ResourceNotFoundError('contract was not found'))
      const reason = Reason.create(request.reason)
      if (reason.isLeft()) return left(reason.value)
      const now = this.clock.now()
      const renewed = contract.renew(
        {
          today: BusinessDate.of(now),
          actor: context.actor,
          readjustmentBasisPoints: request.readjustmentBasisPoints ?? null,
          reason: reason.value,
          automatic: false,
        },
        now,
      )
      if (renewed.isLeft()) return left(renewed.value)
      await scope.contracts.save(contract)
      await recordRenewal(scope, context, contract, renewed.value.number, now)
      return right({
        contractId: request.contractId,
        revision: renewed.value.number,
        endsOn: contract.endsOn?.value ?? null,
      })
    })
  }
}

/**
 * Renew every self-renewing contract whose last period has begun. Running it again renews
 * nothing twice: a renewed contract's last period lies a whole term ahead.
 */
export class RenewDueContractsUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(context: CommandContext): Promise<{ renewed: readonly string[] }> {
    const now = this.clock.now()
    const today = BusinessDate.of(now)
    const horizon = today.plusDays(400).value
    const candidates = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.contracts.renewable(horizon),
    )
    const renewed: string[] = []
    for (const contractId of candidates) {
      const done = await this.unitOfWork.inTenant(context.tenantId, async (scope) => {
        const contract = await scope.contracts.findById(contractId)
        if (!contract) return false
        const revision = contract.renew(
          {
            today,
            actor: RENEWAL_ACTOR,
            readjustmentBasisPoints: null,
            reason: null,
            automatic: true,
          },
          now,
        )
        if (revision.isLeft()) return false
        await scope.contracts.save(contract)
        await recordRenewal(
          scope,
          { ...context, actor: RENEWAL_ACTOR },
          contract,
          revision.value.number,
          now,
        )
        return true
      })
      if (done) renewed.push(contractId)
    }
    return { renewed }
  }
}

type Decision =
  | { readonly kind: 'activate' }
  | {
      readonly kind: 'suspend'
      readonly from: string
      readonly until?: string | undefined
      readonly reason: string
    }
  | { readonly kind: 'resume'; readonly at: string }
  | { readonly kind: 'cancel'; readonly from?: string | undefined; readonly reason: string }

/** Activating, suspending, resuming and cancelling: refused by the contract's own state when repeated. */
export class DecideContractUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  activate(context: CommandContext, contractId: string) {
    return this.decide(context, contractId, { kind: 'activate' })
  }

  suspend(
    context: CommandContext,
    contractId: string,
    input: { from: string; until?: string | undefined; reason: string },
  ) {
    return this.decide(context, contractId, { kind: 'suspend', ...input })
  }

  resume(context: CommandContext, contractId: string, at: string) {
    return this.decide(context, contractId, { kind: 'resume', at })
  }

  cancel(
    context: CommandContext,
    contractId: string,
    input: { from?: string | undefined; reason: string },
  ) {
    return this.decide(context, contractId, { kind: 'cancel', ...input })
  }

  private decide(
    context: CommandContext,
    contractId: string,
    decision: Decision,
  ): Outcome<{ contractId: string; status: string; version: number }> {
    return this.unitOfWork.inTenant(context.tenantId, async (scope) => {
      const contract = await scope.contracts.findById(contractId)
      if (!contract) return left(new ResourceNotFoundError('contract was not found'))
      const now = this.clock.now()
      const today = BusinessDate.of(now)
      const applied = apply(contract, decision, { today, actor: context.actor }, now)
      if (applied.isLeft()) return left(applied.value)
      await scope.contracts.save(contract)
      const { kind, ...details } = decision
      await audit(scope, context, {
        action: `contract.${kind}`,
        subjectType: 'contract',
        subjectId: contractId,
        occurredAt: now,
        details,
      })
      return right({ contractId, status: contract.statusOn(today), version: contract.version })
    })
  }
}

function apply(
  contract: ServiceContract,
  decision: Decision,
  change: { today: BusinessDate; actor: string },
  now: Date,
): Either<Failure, void> {
  if (decision.kind === 'activate') return contract.activate(now)
  if (decision.kind === 'resume') {
    const at = BusinessDate.create(decision.at, '/at')
    return at.isLeft() ? left(at.value) : contract.resume({ ...change, at: at.value }, now)
  }
  const reason = Reason.create(decision.reason)
  if (reason.isLeft()) return left(reason.value)
  const from: Either<InvalidInputError, BusinessDate | null> = decision.from
    ? BusinessDate.create(decision.from, '/from')
    : right(null)
  if (from.isLeft()) return left(from.value)
  if (decision.kind === 'cancel')
    return contract.cancel({ ...change, from: from.value, reason: reason.value }, now)
  if (!from.value) return left(new InvalidInputError('/from', 'a suspension starts at a period'))
  const until: Either<InvalidInputError, BusinessDate | null> = decision.until
    ? BusinessDate.create(decision.until, '/until')
    : right(null)
  if (until.isLeft()) return left(until.value)
  return contract.suspend(
    {
      ...change,
      suspensionId: new UniqueEntityID().toString(),
      from: from.value,
      until: until.value,
      reason: reason.value,
    },
    now,
  )
}

async function recordRenewal(
  scope: SalesScope,
  context: CommandContext,
  contract: ServiceContract,
  revision: number,
  now: Date,
): Promise<void> {
  await audit(scope, context, {
    action: 'contract.renewed',
    subjectType: 'contract',
    subjectId: contract.id.toString(),
    occurredAt: now,
    details: { revision, endsOn: contract.endsOn?.value ?? null },
  })
}

/** A draft's customer, lines, dates and payment terms, each checked. */
async function termsOfContract(
  scope: SalesScope,
  request: ContractRequest,
): Promise<
  Either<
    Failure,
    {
      lines: readonly ContractLine[]
      dates: { startsOn: BusinessDate; endsOn: BusinessDate | null }
      paymentTerms: PaymentTerms
      currency: Money['currency']
    }
  >
> {
  const customer = await scope.customers.findById(request.customerId)
  if (!customer) return left(new ResourceNotFoundError('customer was not found'))
  if (!customer.isActive()) return left(new ConflictError('customer is no longer active'))
  const lines = await contractLines(scope, request.lines)
  if (lines.isLeft()) return left(lines.value)
  const [first] = lines.value
  if (!first) return left(new InvalidInputError('/lines', 'a contract bills at least one line'))
  const dates = datesOf(request)
  if (dates.isLeft()) return left(dates.value)
  const paymentTerms = PaymentTerms.create(request.paymentTermDays ?? [0])
  if (paymentTerms.isLeft()) return left(paymentTerms.value)
  return right({
    lines: lines.value,
    dates: dates.value,
    paymentTerms: paymentTerms.value,
    currency: first.unitPrice.currency,
  })
}

/** Service lines priced from the Catalog projection, or at the price that was negotiated. */
async function contractLines(
  scope: SalesScope,
  inputs: readonly ContractLineInput[],
): Promise<Either<Failure, readonly ContractLine[]>> {
  const priced = await priceLines(scope, inputs)
  if (priced.isLeft()) return left(priced.value)
  const kinds = await scope.catalogItems.kindsOf(priced.value.map((line) => line.itemId))
  const services = servicesOnly(priced.value, kinds)
  if (services.isLeft()) return left(services.value)
  const lines: ContractLine[] = []
  for (const [index, line] of priced.value.entries()) {
    const negotiated = inputs[index]?.unitPrice
    const unitPrice: Either<InvalidInputError, Money> = negotiated
      ? Money.create(negotiated, line.unitPrice.currency)
      : right(line.unitPrice)
    if (unitPrice.isLeft())
      return left(new InvalidInputError(`/lines/${index}/unitPrice`, unitPrice.value.message))
    lines.push({
      lineId: line.lineId,
      itemId: line.itemId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: unitPrice.value,
    })
  }
  return right(lines)
}

function datesOf(
  request: Pick<ContractRequest, 'startsOn' | 'endsOn'>,
): Either<InvalidInputError, { startsOn: BusinessDate; endsOn: BusinessDate | null }> {
  const startsOn = BusinessDate.create(request.startsOn, '/startsOn')
  if (startsOn.isLeft()) return left(startsOn.value)
  if (!request.endsOn) return right({ startsOn: startsOn.value, endsOn: null })
  const endsOn = BusinessDate.create(request.endsOn, '/endsOn')
  if (endsOn.isLeft()) return left(endsOn.value)
  return right({ startsOn: startsOn.value, endsOn: endsOn.value })
}
