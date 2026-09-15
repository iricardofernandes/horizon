import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type {
  CustomerEmail,
  CustomerName,
  CustomerPhone,
  TaxId,
} from '../value-objects/sales-values'

export type CustomerStatus = 'active' | 'erased'

interface CustomerProps {
  tenantId: string
  name: CustomerName
  taxId: TaxId
  email: CustomerEmail
  phone: CustomerPhone
  address: string
  status: CustomerStatus
  createdAt: Date
  updatedAt: Date
}

export class Customer extends AggregateRoot<CustomerProps> {
  static create(
    props: Omit<CustomerProps, 'status' | 'createdAt' | 'updatedAt'> & { now: Date },
    id?: UniqueEntityID,
  ): Customer {
    return new Customer(
      {
        tenantId: props.tenantId,
        name: props.name,
        taxId: props.taxId,
        email: props.email,
        phone: props.phone,
        address: props.address,
        status: 'active',
        createdAt: props.now,
        updatedAt: props.now,
      },
      id,
    )
  }

  static rehydrate(props: CustomerProps, id: UniqueEntityID): Customer {
    return new Customer(props, id)
  }

  erase(now: Date): void {
    this.props.status = 'erased'
    this.props.updatedAt = now
  }

  belongsTo(tenantId: string): boolean {
    return this.props.tenantId === tenantId
  }

  isActive(): boolean {
    return this.props.status === 'active'
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    name: string
    taxId: string
    email: string
    phone: string
    address: string
    status: CustomerStatus
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      name: this.props.name.value,
      taxId: this.props.taxId.value,
      email: this.props.email.value,
      phone: this.props.phone.value,
      address: this.props.address,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
