import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { PriceList } from '@/domain/entities/price-list'
import { CatalogName, Currency, Money } from '@/domain/value-objects/catalog-values'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

type PriceError = InvalidInputError | ConflictError | ResourceNotFoundError
export class CreatePriceListUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}
  async execute(request: {
    tenantId: string
    name: string
    currency: string
  }): Promise<Either<PriceError, { priceListId: string }>> {
    const name = CatalogName.create(request.name)
    if (name.isLeft()) return left(name.value)
    const currency = Currency.create(request.currency)
    if (currency.isLeft()) return left(currency.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.priceLists.findByName(name.value.value))
        return left(new ConflictError(`price list "${name.value.value}" already exists`))
      const priceList = PriceList.create({
        tenantId: request.tenantId,
        name: name.value,
        currency: currency.value,
        createdAt: this.clock.now(),
      })
      await scope.priceLists.create(priceList)
      return right({ priceListId: priceList.id.toString() })
    })
  }
}

export class SetPriceUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}
  async execute(request: {
    tenantId: string
    priceListId: string
    itemId: string
    amount: string
    currency: string
  }): Promise<Either<PriceError, void>> {
    const currency = Currency.create(request.currency)
    if (currency.isLeft()) return left(currency.value)
    const money = Money.create(request.amount, currency.value)
    if (money.isLeft()) return left(money.value)
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const [priceList, item] = await Promise.all([
        scope.priceLists.findById(request.priceListId),
        scope.items.findById(request.itemId),
      ])
      if (!priceList) return left(new ResourceNotFoundError('price list'))
      if (!item?.isActive()) return left(new ResourceNotFoundError('active catalog item'))
      const changed = priceList.setPrice(request.itemId, money.value, this.clock.now())
      if (changed.isLeft()) return left(changed.value)
      await scope.priceLists.save(priceList)
      return right(undefined)
    })
  }
}
