import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  CategoriesRepository,
  DimensionsRepository,
  PaymentMethodsRepository,
  PaymentTermsRepository,
} from '@/domain/repositories/dimension-repositories'
import type {
  PartyProjectionRepository,
  TitlesRepository,
} from '@/domain/repositories/title-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025, ADR 0042). */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType: 'title'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export abstract class AuditTrail {
  abstract append(record: AuditRecord): Promise<void>
}

export interface FinancialScope {
  readonly tenantId: string
  readonly categories: CategoriesRepository
  readonly dimensions: DimensionsRepository
  readonly paymentMethods: PaymentMethodsRepository
  readonly paymentTerms: PaymentTermsRepository
  readonly titles: TitlesRepository
  readonly parties: PartyProjectionRepository
  readonly audit: AuditTrail
}

/** What makes a retried command recognisable: the caller's key and what it asked for. */
export interface CommandReceipt {
  readonly idempotencyKey: string
  readonly command: string
  readonly fingerprint: string
}

export interface ReceivedEvent {
  readonly sourceModule: string
  readonly eventId: string
  readonly eventType: string
}

export type EventOutcome<T> =
  | { readonly processed: false }
  | { readonly processed: true; readonly value: T }

export abstract class FinancialUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: FinancialScope) => Promise<T>): Promise<T>

  /**
   * Run a money-moving command at most once per idempotency key (ADR 0028). A retry with the
   * same key and request gets the first response back without running again; the same key
   * with a different request is refused. A refused command stores nothing, so it may be
   * retried once its cause is fixed.
   */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: FinancialScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>

  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: FinancialScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
