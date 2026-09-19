import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  CatalogItemsRepository,
  CustomersRepository,
  QuotesRepository,
  SalesEventsRepository,
  SalesOrdersRepository,
} from '@/domain/repositories/sales-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025). */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType: 'quote' | 'order'
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

export interface SalesScope {
  readonly tenantId: string
  readonly orders: SalesOrdersRepository
  readonly catalogItems: CatalogItemsRepository
  readonly events: SalesEventsRepository
  readonly customers: CustomersRepository
  readonly quotes: QuotesRepository
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

export abstract class SalesUnitOfWork {
  abstract provisionTenant(tenantId: string): Promise<void>
  abstract inTenant<T>(tenantId: string, work: (scope: SalesScope) => Promise<T>): Promise<T>

  /** Run a committing command at most once per idempotency key (ADR 0028). */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: SalesScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>

  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: SalesScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
