import type {
  CatalogItemsRepository,
  CustomersRepository,
  QuotesRepository,
  SalesEventsRepository,
  SalesOrdersRepository,
} from '@/domain/repositories/sales-repositories'

export interface SalesScope {
  readonly tenantId: string
  readonly orders: SalesOrdersRepository
  readonly catalogItems: CatalogItemsRepository
  readonly events: SalesEventsRepository
  readonly customers: CustomersRepository
  readonly quotes: QuotesRepository
}

export interface ReceivedEvent {
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

export type EventOutcome<T> =
  | { readonly processed: false }
  | { readonly processed: true; readonly value: T }

export abstract class SalesUnitOfWork {
  abstract provisionTenant(tenantId: string): Promise<void>
  abstract inTenant<T>(tenantId: string, work: (scope: SalesScope) => Promise<T>): Promise<T>
  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: SalesScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
