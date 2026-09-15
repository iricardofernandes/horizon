import type {
  InventoryEventsRepository,
  StockBalancesRepository,
  StockReservationsRepository,
} from '@/domain/repositories/inventory-repositories'

export interface InventoryScope {
  readonly tenantId: string
  readonly balances: StockBalancesRepository
  readonly reservations: StockReservationsRepository
  readonly events: InventoryEventsRepository
}

export interface ReceivedEvent {
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

export type EventOutcome<T> =
  | { readonly processed: false }
  | { readonly processed: true; readonly value: T }

export abstract class InventoryUnitOfWork {
  abstract provisionTenant(tenantId: string): Promise<void>
  abstract inTenant<T>(tenantId: string, work: (scope: InventoryScope) => Promise<T>): Promise<T>
  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
