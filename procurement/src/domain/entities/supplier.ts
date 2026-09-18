import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { PartyName } from '../value-objects/procurement-values'

export const SUPPLIER_STATUSES = ['active', 'inactive', 'erased'] as const
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]

export interface SupplierDetails {
  readonly name: PartyName
  readonly email: string
  readonly phone: string
  readonly address: string
}

interface SupplierProps {
  tenantId: string
  name: PartyName
  email: string
  phone: string
  address: string
  status: SupplierStatus
  createdAt: Date
  updatedAt: Date
}

/**
 * Procurement's projection of a party that holds the `supplier` role (ADR 0040).
 *
 * Procurement never registers a supplier; it follows `parties/`. The id is the party id,
 * so an order references the same identifier the payable will. What is kept here is what
 * writing and sending an order needs — a name and a way to reach them — and a status that
 * decides whether a new order may be placed with them. Orders already placed keep their
 * own snapshot and are unaffected by any of it.
 */
export class Supplier extends AggregateRoot<SupplierProps> {
  static project(
    props: SupplierDetails & { tenantId: string; active: boolean; now: Date },
    partyId: UniqueEntityID,
  ): Supplier {
    return new Supplier(
      {
        tenantId: props.tenantId,
        name: props.name,
        email: props.email,
        phone: props.phone,
        address: props.address,
        status: props.active ? 'active' : 'inactive',
        createdAt: props.now,
        updatedAt: props.now,
      },
      partyId,
    )
  }

  static rehydrate(props: SupplierProps, id: UniqueEntityID): Supplier {
    return new Supplier(props, id)
  }

  get name(): PartyName {
    return this.props.name
  }

  /** Replace the projected details. An erased supplier is never brought back. */
  refresh(details: SupplierDetails & { active: boolean }, now: Date): boolean {
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
    email: string
    phone: string
    address: string
    status: SupplierStatus
    createdAt: Date
    updatedAt: Date
  }> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      name: this.props.name.value,
      email: this.props.email,
      phone: this.props.phone,
      address: this.props.address,
      status: this.props.status,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
    })
  }
}
