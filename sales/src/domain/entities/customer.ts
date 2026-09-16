import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type {
  CustomerEmail,
  CustomerName,
  CustomerPhone,
  TaxId,
} from '../value-objects/sales-values'

export type CustomerStatus = 'active' | 'inactive' | 'erased'

export interface CustomerDetails {
  readonly name: CustomerName
  readonly email: CustomerEmail
  readonly phone: CustomerPhone
  readonly address: string
}

interface CustomerProps {
  name: CustomerName
  email: CustomerEmail
  phone: CustomerPhone
  address: string
  tenantId: string
  /** Present only on customers Sales registered before the party registry existed. */
  taxId: TaxId | null
  status: CustomerStatus
  createdAt: Date
  updatedAt: Date
}

/**
 * Sales' projection of a party that holds the `customer` role (ADR 0040).
 *
 * Sales no longer registers customers; it follows `parties/`. The id is the party id, so a
 * quote or order references the same identifier Finance and Fiscal will. What Sales keeps
 * is what a commercial document needs — a name to print, a way to reach them — and a
 * status that decides whether a new document may be issued to them.
 */
export class Customer extends AggregateRoot<CustomerProps> {
  static project(
    props: CustomerDetails & { tenantId: string; active: boolean; now: Date },
    partyId: UniqueEntityID,
  ): Customer {
    return new Customer(
      {
        tenantId: props.tenantId,
        name: props.name,
        email: props.email,
        phone: props.phone,
        address: props.address,
        taxId: null,
        status: props.active ? 'active' : 'inactive',
        createdAt: props.now,
        updatedAt: props.now,
      },
      partyId,
    )
  }

  static rehydrate(props: CustomerProps, id: UniqueEntityID): Customer {
    return new Customer(props, id)
  }

  /** Replace the projected details. An erased customer is never brought back. */
  refresh(details: CustomerDetails & { active: boolean }, now: Date): boolean {
    if (this.props.status === 'erased') return false
    this.props.name = details.name
    this.props.email = details.email
    this.props.phone = details.phone
    this.props.address = details.address
    this.props.status = details.active ? 'active' : 'inactive'
    this.props.updatedAt = now
    return true
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

  isErased(): boolean {
    return this.props.status === 'erased'
  }

  toSnapshot(): Readonly<{
    id: string
    tenantId: string
    name: string
    taxId: string | null
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
      taxId: this.props.taxId?.value ?? null,
      email: this.props.email.value,
      phone: this.props.phone.value,
      address: this.props.address,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
