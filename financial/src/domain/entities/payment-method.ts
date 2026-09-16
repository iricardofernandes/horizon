import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { Code, Name } from '../value-objects/financial-values'

/** How money moves. Treasury will reconcile each kind differently, so the kind is data. */
export const PAYMENT_METHOD_KINDS = [
  'cash',
  'bank-transfer',
  'pix',
  'boleto',
  'credit-card',
  'debit-card',
  'check',
  'other',
] as const
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number]

interface PaymentMethodProps {
  tenantId: string
  kind: PaymentMethodKind
  code: Code
  name: Name
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface PaymentMethodSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly kind: PaymentMethodKind
  readonly code: string
  readonly name: string
  readonly active: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
}

export class PaymentMethod extends AggregateRoot<PaymentMethodProps> {
  static define(
    props: { tenantId: string; kind: PaymentMethodKind; code: Code; name: Name; now: Date },
    id?: UniqueEntityID,
  ): PaymentMethod {
    return new PaymentMethod(
      { ...props, active: true, createdAt: props.now, updatedAt: props.now },
      id,
    )
  }

  static rehydrate(props: PaymentMethodProps, id: UniqueEntityID): PaymentMethod {
    return new PaymentMethod(props, id)
  }

  isActive(): boolean {
    return this.props.active
  }

  changeStatus(active: boolean, now: Date): Either<ConflictError, void> {
    if (this.props.active === active)
      return left(new ConflictError(`payment method is already ${active ? 'active' : 'inactive'}`))
    this.props.active = active
    this.props.updatedAt = now
    return right(undefined)
  }

  toSnapshot(): Readonly<PaymentMethodSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      kind: this.props.kind,
      code: this.props.code.value,
      name: this.props.name.value,
      active: this.props.active,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
