import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { AnalyticDimension, type DimensionKind } from '@/domain/entities/analytic-dimension'
import { type CategoryNature, FinancialCategory } from '@/domain/entities/financial-category'
import { PaymentMethod, type PaymentMethodKind } from '@/domain/entities/payment-method'
import { type InstallmentRule, PaymentTerm } from '@/domain/entities/payment-term'
import { Allocation, type AllocationEntry } from '@/domain/value-objects/allocation'
import {
  BusinessDate,
  Code,
  Currency,
  Money,
  Name,
  Share,
} from '@/domain/value-objects/financial-values'
import type { Clock } from '../ports/clock'
import type { FinancialScope, FinancialUnitOfWork } from '../ports/unit-of-work'

type Failure = InvalidInputError | ConflictError | ResourceNotFoundError
type Created = Either<Failure, { id: string }>

function codeAndName(
  code: string,
  name: string,
): Either<InvalidInputError, { code: Code; name: Name }> {
  const parsedCode = Code.create(code)
  if (parsedCode.isLeft()) return left(parsedCode.value)
  const parsedName = Name.create(name)
  if (parsedName.isLeft()) return left(parsedName.value)
  return right({ code: parsedCode.value, name: parsedName.value })
}

export class DefineCategoryUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    code: string
    name: string
    nature: CategoryNature
    parentId?: string | undefined
  }): Promise<Created> {
    const parsed = codeAndName(request.code, request.name)
    if (parsed.isLeft()) return left(parsed.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.categories.findByCode(parsed.value.code.value))
        return left(new ConflictError('a category with this code already exists'))
      const parent = request.parentId ? await scope.categories.findById(request.parentId) : null
      if (request.parentId && !parent)
        return left(new ResourceNotFoundError('parent category was not found'))
      const category = FinancialCategory.define(
        {
          tenantId: request.tenantId,
          ...parsed.value,
          nature: request.nature,
          now: this.clock.now(),
        },
        parent,
      )
      if (category.isLeft()) return left(category.value)
      await scope.categories.create(category.value)
      return right({ id: category.value.id.toString() })
    })
  }
}

export class DefineDimensionUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    kind: DimensionKind
    code: string
    name: string
  }): Promise<Created> {
    const parsed = codeAndName(request.code, request.name)
    if (parsed.isLeft()) return left(parsed.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.dimensions.findByCode(request.kind, parsed.value.code.value))
        return left(new ConflictError(`a ${request.kind} with this code already exists`))
      const dimension = AnalyticDimension.define({
        tenantId: request.tenantId,
        kind: request.kind,
        ...parsed.value,
        now: this.clock.now(),
      })
      await scope.dimensions.create(dimension)
      return right({ id: dimension.id.toString() })
    })
  }
}

export class DefinePaymentMethodUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    kind: PaymentMethodKind
    code: string
    name: string
  }): Promise<Created> {
    const parsed = codeAndName(request.code, request.name)
    if (parsed.isLeft()) return left(parsed.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.paymentMethods.findByCode(parsed.value.code.value))
        return left(new ConflictError('a payment method with this code already exists'))
      const method = PaymentMethod.define({
        tenantId: request.tenantId,
        kind: request.kind,
        ...parsed.value,
        now: this.clock.now(),
      })
      await scope.paymentMethods.create(method)
      return right({ id: method.id.toString() })
    })
  }
}

function rulesOf(
  installments: readonly { dueInDays: number; percentage: string }[],
): Either<InvalidInputError, InstallmentRule[]> {
  const rules: InstallmentRule[] = []
  for (const [index, installment] of installments.entries()) {
    const share = Share.fromPercentage(installment.percentage, `/installments/${index}/percentage`)
    if (share.isLeft()) return left(share.value)
    rules.push({ dueInDays: installment.dueInDays, share: share.value })
  }
  return right(rules)
}

export class DefinePaymentTermUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    name: string
    installments: readonly { dueInDays: number; percentage: string }[]
  }): Promise<Created> {
    const name = Name.create(request.name)
    if (name.isLeft()) return left(name.value)
    const rules = rulesOf(request.installments)
    if (rules.isLeft()) return left(rules.value)
    const term = PaymentTerm.define({
      tenantId: request.tenantId,
      name: name.value,
      installments: rules.value,
      now: this.clock.now(),
    })
    if (term.isLeft()) return left(term.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.paymentTerms.findByName(name.value.value))
        return left(new ConflictError('a payment term with this name already exists'))
      await scope.paymentTerms.create(term.value)
      return right({ id: term.value.id.toString() })
    })
  }
}

export type DimensionRegistry = 'categories' | 'dimensions' | 'paymentMethods' | 'paymentTerms'

/** Activation is the only change a registry entry allows; codes stay stable once used. */
export class ChangeRegistryStatusUseCase {
  constructor(
    private readonly unitOfWork: FinancialUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    tenantId: string
    registry: DimensionRegistry
    id: string
    active: boolean
  }): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const repository = scope[request.registry] as FinancialScope['categories']
      const entry = await repository.findById(request.id)
      if (!entry) return left(new ResourceNotFoundError('entry was not found'))
      const changed = entry.changeStatus(request.active, this.clock.now())
      if (changed.isLeft()) return changed
      await repository.save(entry)
      return right(undefined)
    })
  }
}

export interface MoneyInput {
  readonly amount: string
  readonly currency: string
}

function moneyOf(input: MoneyInput): Either<InvalidInputError, Money> {
  const currency = Currency.create(input.currency)
  if (currency.isLeft()) return left(currency.value)
  return Money.create(input.amount, currency.value)
}

/** What a term would do to an amount: the preview a title will later store as its schedule. */
export class PreviewScheduleUseCase {
  constructor(private readonly unitOfWork: FinancialUnitOfWork) {}

  async execute(request: {
    tenantId: string
    paymentTermId: string
    total: MoneyInput
    issuedOn: string
  }): Promise<
    Either<Failure, readonly { number: number; dueOn: string; amount: string; currency: string }[]>
  > {
    const total = moneyOf(request.total)
    if (total.isLeft()) return left(total.value)
    const issuedOn = BusinessDate.create(request.issuedOn, '/issuedOn')
    if (issuedOn.isLeft()) return left(issuedOn.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const term = await scope.paymentTerms.findById(request.paymentTermId)
      if (!term) return left(new ResourceNotFoundError('payment term was not found'))
      if (!term.isActive()) return left(new ConflictError('payment term is inactive'))
      return right(
        term.schedule(total.value, issuedOn.value).map((installment) => ({
          number: installment.number,
          dueOn: installment.dueOn.value,
          amount: installment.amount.amount.toString(),
          currency: installment.amount.currency.value,
        })),
      )
    })
  }
}

/**
 * Split an amount across departments or projects. Every dimension must exist and be
 * active in this workspace, and the shares must add up to exactly 100%.
 */
export class PreviewAllocationUseCase {
  constructor(private readonly unitOfWork: FinancialUnitOfWork) {}

  async execute(request: {
    tenantId: string
    total: MoneyInput
    entries: readonly { dimensionId: string; percentage: string }[]
  }): Promise<
    Either<
      Failure,
      readonly { dimensionId: string; percentage: string; amount: string; currency: string }[]
    >
  > {
    const total = moneyOf(request.total)
    if (total.isLeft()) return left(total.value)
    const entries: AllocationEntry[] = []
    for (const [index, entry] of request.entries.entries()) {
      const share = Share.fromPercentage(entry.percentage, `/entries/${index}/percentage`)
      if (share.isLeft()) return left(share.value)
      entries.push({ dimensionId: entry.dimensionId, share: share.value })
    }
    const allocation = Allocation.of(entries)
    if (allocation.isLeft()) return left(allocation.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const found = await scope.dimensions.findByIds(entries.map((entry) => entry.dimensionId))
      const usable = new Set(
        found
          .filter((dimension) => dimension.isActive())
          .map((dimension) => dimension.id.toString()),
      )
      const missing = entries.find((entry) => !usable.has(entry.dimensionId))
      if (missing)
        return left(
          new ResourceNotFoundError(`dimension ${missing.dimensionId} is not an active dimension`),
        )
      return right(
        allocation.value.split(total.value).map((part) => ({
          dimensionId: part.dimensionId,
          percentage: part.share.toPercentage(),
          amount: part.amount.amount.toString(),
          currency: part.amount.currency.value,
        })),
      )
    })
  }
}
