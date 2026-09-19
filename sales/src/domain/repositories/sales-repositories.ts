import type { DomainEvent } from '@/core/events/domain-event'
import type { Customer } from '../entities/customer'
import type { Quote } from '../entities/quote'
import type { SalesOrder } from '../entities/sales-order'
import type { Shipment } from '../entities/shipment'
import type { LineDescription, Money } from '../value-objects/sales-values'

export interface CatalogItemProjection {
  readonly tenantId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly unitPrice: Money
  readonly active: boolean
}

export abstract class SalesOrdersRepository {
  abstract findById(id: string): Promise<SalesOrder | null>
  abstract create(order: SalesOrder): Promise<void>
  abstract save(order: SalesOrder): Promise<void>
}

/** A projection fed by `parties/`; Sales never registers a customer itself (ADR 0040). */
export abstract class CustomersRepository {
  abstract findById(id: string): Promise<Customer | null>
  abstract create(customer: Customer): Promise<void>
  abstract save(customer: Customer): Promise<void>
  abstract erase(customer: Customer): Promise<void>
}

export abstract class ShipmentsRepository {
  abstract findById(id: string): Promise<Shipment | null>
  abstract create(shipment: Shipment): Promise<void>
  abstract save(shipment: Shipment): Promise<void>
}

export abstract class QuotesRepository {
  abstract findById(id: string): Promise<Quote | null>
  abstract create(quote: Quote): Promise<void>
  abstract save(quote: Quote): Promise<void>
}

export abstract class CatalogItemsRepository {
  abstract findById(id: string): Promise<CatalogItemProjection | null>
  abstract recordItem(item: {
    tenantId: string
    itemId: string
    description: LineDescription
  }): Promise<void>
  abstract recordPrice(itemId: string, unitPrice: Money): Promise<void>
  abstract deactivate(itemId: string): Promise<void>
}

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class SalesEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
