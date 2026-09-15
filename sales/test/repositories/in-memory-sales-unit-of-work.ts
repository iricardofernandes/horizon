import type { EventOutcome, ReceivedEvent, SalesScope } from '@/application/ports/unit-of-work'
import { SalesUnitOfWork } from '@/application/ports/unit-of-work'
import type { DomainEvent } from '@/core/events/domain-event'
import type { Customer } from '@/domain/entities/customer'
import type { Quote } from '@/domain/entities/quote'
import type { SalesOrder } from '@/domain/entities/sales-order'
import {
  type CatalogItemProjection,
  CatalogItemsRepository,
  CustomersRepository,
  QuotesRepository,
  SalesEventsRepository,
  SalesOrdersRepository,
} from '@/domain/repositories/sales-repositories'

class InMemoryOrders extends SalesOrdersRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: SalesOrder[],
  ) {
    super()
  }
  findById(id: string): Promise<SalesOrder | null> {
    return Promise.resolve(
      this.records.find((order) => order.belongsTo(this.tenantId) && order.id.toString() === id) ??
        null,
    )
  }
  create(order: SalesOrder): Promise<void> {
    if (!order.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(order)
    return Promise.resolve()
  }
  save(order: SalesOrder): Promise<void> {
    if (!order.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryCatalogItems extends CatalogItemsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: CatalogItemProjection[],
    private readonly pending: Map<
      string,
      Partial<Pick<CatalogItemProjection, 'description' | 'unitPrice' | 'active'>>
    >,
  ) {
    super()
  }
  private key(itemId: string): string {
    return `${this.tenantId}:${itemId}`
  }
  findById(id: string): Promise<CatalogItemProjection | null> {
    const complete = this.records.find(
      (item) => item.tenantId === this.tenantId && item.itemId === id,
    )
    if (complete) return Promise.resolve(complete)
    const projected = this.pending.get(this.key(id))
    return Promise.resolve(
      projected?.description && projected.unitPrice
        ? {
            tenantId: this.tenantId,
            itemId: id,
            description: projected.description,
            unitPrice: projected.unitPrice,
            active: projected.active ?? true,
          }
        : null,
    )
  }
  recordItem(item: {
    tenantId: string
    itemId: string
    description: CatalogItemProjection['description']
  }): Promise<void> {
    if (item.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    const key = this.key(item.itemId)
    const existing = this.pending.get(key) ?? {}
    this.pending.set(key, { ...existing, description: item.description, active: true })
    return Promise.resolve()
  }
  recordPrice(itemId: string, unitPrice: CatalogItemProjection['unitPrice']): Promise<void> {
    const key = this.key(itemId)
    const existing = this.pending.get(key) ?? {}
    this.pending.set(key, { ...existing, unitPrice })
    return Promise.resolve()
  }
  deactivate(itemId: string): Promise<void> {
    const key = this.key(itemId)
    const existing = this.pending.get(key) ?? {}
    this.pending.set(key, { ...existing, active: false })
    return Promise.resolve()
  }
}

class InMemoryEvents extends SalesEventsRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: DomainEvent[],
  ) {
    super()
  }
  append(event: DomainEvent): Promise<void> {
    if (event.tenantId !== this.tenantId) throw new Error('tenant mismatch')
    this.records.push(event)
    return Promise.resolve()
  }
}

class InMemoryCustomers extends CustomersRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: Customer[],
  ) {
    super()
  }
  findById(id: string): Promise<Customer | null> {
    return Promise.resolve(
      this.records.find(
        (customer) => customer.belongsTo(this.tenantId) && customer.id.toString() === id,
      ) ?? null,
    )
  }
  findByTaxId(taxId: string): Promise<Customer | null> {
    return Promise.resolve(
      this.records.find(
        (customer) =>
          customer.belongsTo(this.tenantId) &&
          customer.isActive() &&
          customer.toSnapshot().taxId === taxId,
      ) ?? null,
    )
  }
  create(customer: Customer): Promise<void> {
    if (!customer.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(customer)
    return Promise.resolve()
  }
  erase(customer: Customer): Promise<void> {
    if (!customer.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

class InMemoryQuotes extends QuotesRepository {
  constructor(
    private readonly tenantId: string,
    private readonly records: Quote[],
  ) {
    super()
  }
  findById(id: string): Promise<Quote | null> {
    return Promise.resolve(
      this.records.find((quote) => quote.belongsTo(this.tenantId) && quote.id.toString() === id) ??
        null,
    )
  }
  create(quote: Quote): Promise<void> {
    if (!quote.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    this.records.push(quote)
    return Promise.resolve()
  }
  save(quote: Quote): Promise<void> {
    if (!quote.belongsTo(this.tenantId)) throw new Error('tenant mismatch')
    return Promise.resolve()
  }
}

export class InMemorySalesUnitOfWork extends SalesUnitOfWork {
  readonly orders: SalesOrder[] = []
  readonly catalogItems: CatalogItemProjection[] = []
  readonly projectedCatalogItems = new Map<
    string,
    Partial<Pick<CatalogItemProjection, 'description' | 'unitPrice' | 'active'>>
  >()
  readonly events: DomainEvent[] = []
  readonly customers: Customer[] = []
  readonly quotes: Quote[] = []
  readonly provisionedTenants = new Set<string>()
  readonly consumedEvents = new Set<string>()

  provisionTenant(tenantId: string): Promise<void> {
    this.provisionedTenants.add(tenantId)
    return Promise.resolve()
  }

  inTenant<T>(tenantId: string, work: (scope: SalesScope) => Promise<T>): Promise<T> {
    return work({
      tenantId,
      orders: new InMemoryOrders(tenantId, this.orders),
      catalogItems: new InMemoryCatalogItems(
        tenantId,
        this.catalogItems,
        this.projectedCatalogItems,
      ),
      events: new InMemoryEvents(tenantId, this.events),
      customers: new InMemoryCustomers(tenantId, this.customers),
      quotes: new InMemoryQuotes(tenantId, this.quotes),
    })
  }

  async processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: SalesScope) => Promise<T>,
  ): Promise<EventOutcome<T>> {
    const key = `${tenantId}:${event.sourceModule}:${event.eventId}`
    if (this.consumedEvents.has(key)) return { processed: false }
    const value = await this.inTenant(tenantId, work)
    this.consumedEvents.add(key)
    return { processed: true, value }
  }
}
