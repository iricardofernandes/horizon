import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { LineDescription, Money, Quantity } from '../value-objects/sales-values'

export type QuoteStatus = 'draft' | 'accepted' | 'expired'

export interface QuoteLine {
  readonly lineId: string
  readonly itemId: string
  readonly quantity: Quantity
  readonly description: LineDescription
  readonly unitPrice: Money
  readonly lineTotal: Money
}

interface QuoteProps {
  tenantId: string
  customerId: string
  lines: readonly QuoteLine[]
  total: Money
  status: QuoteStatus
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export class Quote extends AggregateRoot<QuoteProps> {
  static draft(
    props: Omit<QuoteProps, 'status' | 'createdAt' | 'updatedAt'> & { now: Date },
    id?: UniqueEntityID,
  ): Quote {
    if (props.lines.length === 0) throw new RangeError('a quote requires at least one line')
    if (props.expiresAt.getTime() <= props.now.getTime())
      throw new RangeError('quote expiry must be after creation')
    return new Quote(
      {
        tenantId: props.tenantId,
        customerId: props.customerId,
        lines: props.lines,
        total: props.total,
        status: 'draft',
        expiresAt: props.expiresAt,
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
  }

  static rehydrate(props: QuoteProps, id: UniqueEntityID): Quote {
    return new Quote(props, id)
  }

  accept(now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'draft') return left(new ConflictError('quote is not open'))
    if (now.getTime() >= this.props.expiresAt.getTime()) {
      this.props.status = 'expired'
      this.props.updatedAt = now
      return left(new ConflictError('quote has expired'))
    }
    this.props.status = 'accepted'
    this.props.updatedAt = now
    return right(undefined)
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    customerId: string
    status: QuoteStatus
    expiresAt: Date
    total: { amount: string; currency: string }
    lines: readonly {
      lineId: string
      itemId: string
      quantity: string
      description: string
      unitPrice: string
      lineTotal: string
    }[]
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      customerId: this.props.customerId,
      status: this.props.status,
      expiresAt: this.props.expiresAt,
      total: {
        amount: this.props.total.amount.toString(),
        currency: this.props.total.currency.value,
      },
      lines: this.props.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        quantity: line.quantity.toString(),
        description: line.description.value,
        unitPrice: line.unitPrice.amount.toString(),
        lineTotal: line.lineTotal.amount.toString(),
      })),
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
