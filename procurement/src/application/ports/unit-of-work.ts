import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  ApprovalPoliciesRepository,
  CatalogItemsRepository,
  PurchaseOrdersRepository,
  QuotationsRepository,
  ReceiptsRepository,
  RequisitionsRepository,
  SuppliersRepository,
} from '@/domain/repositories/procurement-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025). */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType: 'requisition' | 'quotation' | 'order' | 'receipt' | 'policy' | 'supplier'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export abstract class AuditTrail {
  abstract append(record: AuditRecord): Promise<void>
}

export interface ProcurementScope {
  readonly tenantId: string
  readonly requisitions: RequisitionsRepository
  readonly quotations: QuotationsRepository
  readonly orders: PurchaseOrdersRepository
  readonly receipts: ReceiptsRepository
  readonly suppliers: SuppliersRepository
  readonly catalogItems: CatalogItemsRepository
  readonly policies: ApprovalPoliciesRepository
  readonly audit: AuditTrail
}

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

export abstract class ProcurementUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: ProcurementScope) => Promise<T>): Promise<T>

  /** Run a committing command at most once per idempotency key (ADR 0028). */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: ProcurementScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>

  /** Handle an event at most once per source and id, in one transaction with its effect. */
  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: ProcurementScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
