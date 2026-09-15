import type { DomainEvent } from '@/core/events/domain-event'
import type { StockBalance } from '../entities/stock-balance'
import type { StockReservation } from '../entities/stock-reservation'

export abstract class StockBalancesRepository {
  /** Locks this balance until the surrounding tenant transaction commits. */
  abstract lock(itemId: string, warehouseId: string): Promise<StockBalance | null>
  abstract save(balance: StockBalance): Promise<void>
}

export abstract class StockReservationsRepository {
  abstract findByOrderId(orderId: string): Promise<StockReservation | null>
  abstract create(reservation: StockReservation): Promise<void>
  abstract save(reservation: StockReservation): Promise<void>
}

/** Persists domain events to the outbox owned by the surrounding transaction. */
export abstract class InventoryEventsRepository {
  abstract append(event: DomainEvent): Promise<void>
}
