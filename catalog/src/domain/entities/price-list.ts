import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { CatalogPriceChangedEvent } from '../events/catalog-events'
import type { CatalogName, Currency, Money } from '../value-objects/catalog-values'

export interface PriceEntrySnapshot {
  readonly itemId: string
  readonly amount: string
}
interface PriceListProps {
  tenantId: string
  name: CatalogName
  currency: Currency
  prices: Map<string, bigint>
  active: boolean
  createdAt: Date
  updatedAt: Date
}
export interface PriceListSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly name: string
  readonly currency: string
  readonly prices: readonly PriceEntrySnapshot[]
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export class PriceList extends AggregateRoot<PriceListProps> {
  static create(
    props: {
      tenantId: string
      name: CatalogName
      currency: Currency
      prices?: ReadonlyMap<string, bigint>
      active?: boolean
      createdAt?: Date
      updatedAt?: Date
    },
    id?: UniqueEntityID,
  ): PriceList {
    const now = props.createdAt ?? new Date()
    return new PriceList(
      {
        tenantId: props.tenantId,
        name: props.name,
        currency: props.currency,
        prices: new Map(props.prices),
        active: props.active ?? true,
        createdAt: now,
        updatedAt: props.updatedAt ?? now,
      },
      id,
    )
  }
  setPrice(itemId: string, money: Money, now: Date): Either<ConflictError, void> {
    if (!this.props.active) return left(new ConflictError('price list is inactive'))
    if (!money.currency.equals(this.props.currency))
      return left(new ConflictError('price currency differs from the price list currency'))
    this.props.prices.set(itemId, money.amount)
    this.props.updatedAt = now
    this.addDomainEvent(
      new CatalogPriceChangedEvent(this.id, this.props.tenantId, now, {
        itemId,
        amount: money.amount.toString(),
        currency: money.currency.value,
      }),
    )
    return right(undefined)
  }
  priceOf(itemId: string): bigint | null {
    return this.props.prices.get(itemId) ?? null
  }
  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }
  toSnapshot(): Readonly<PriceListSnapshot> {
    const prices = [...this.props.prices.entries()].map(([itemId, amount]) =>
      Object.freeze({ itemId, amount: amount.toString() }),
    )
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      name: this.props.name.value,
      currency: this.props.currency.value,
      prices: Object.freeze(prices),
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
