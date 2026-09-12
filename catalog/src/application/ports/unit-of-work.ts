import type { AuditLogRepository } from '@/domain/repositories/audit-log-repository'
import type {
  CatalogItemsRepository,
  PriceListsRepository,
  UnitsRepository,
} from '@/domain/repositories/catalog-repositories'

export interface TenantScope {
  readonly tenantId: string
  readonly units: UnitsRepository
  readonly items: CatalogItemsRepository
  readonly priceLists: PriceListsRepository
  readonly audit: AuditLogRepository
}

/** What identifies a consumed event well enough to recognise it a second time. */
export interface ReceivedEvent {
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

export type EventOutcome<T> = { processed: false } | { processed: true; value: T }

export abstract class UnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: TenantScope) => Promise<T>): Promise<T>

  /** The tenant mirror every foreign key depends on. Repeating it changes nothing. */
  abstract provisionTenant(tenantId: string): Promise<void>

  /**
   * Run `work` at most once for this event, ever.
   *
   * The claim on `(source_module, event_id)` and the work commit together, so a handler
   * that throws leaves no claim behind and a redelivery is free to try again. Delivery is
   * at-least-once (ADR 0024); this is what makes the *effect* exactly-once.
   */
  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: TenantScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
