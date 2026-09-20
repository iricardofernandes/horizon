import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  AdjustmentPoliciesRepository,
  InventoryEventsRepository,
  StockAdjustmentsRepository,
  StockBalancesRepository,
  StockCountsRepository,
  StockReservationsRepository,
  StockTransfersRepository,
  WarehousesRepository,
} from '@/domain/repositories/inventory-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025). */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType: 'warehouse' | 'transfer' | 'adjustment' | 'count' | 'policy'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export abstract class AuditTrail {
  abstract append(record: AuditRecord): Promise<void>
}

export interface CommandReceipt {
  readonly idempotencyKey: string
  readonly command: string
  readonly fingerprint: string
}

export interface InventoryScope {
  readonly tenantId: string
  readonly warehouses: WarehousesRepository
  readonly balances: StockBalancesRepository
  readonly reservations: StockReservationsRepository
  readonly transfers: StockTransfersRepository
  readonly adjustments: StockAdjustmentsRepository
  readonly counts: StockCountsRepository
  readonly policies: AdjustmentPoliciesRepository
  readonly events: InventoryEventsRepository
  readonly audit: AuditTrail
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

  /** Run a committing command at most once per idempotency key (ADR 0028). */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: InventoryScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>

  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: InventoryScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
