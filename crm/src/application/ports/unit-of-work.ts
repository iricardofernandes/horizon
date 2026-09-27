import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  AccountsRepository,
  ActivitiesRepository,
  ContactsRepository,
  ListEntriesRepository,
  NotesRepository,
  OpportunitiesRepository,
  OwnersRepository,
  PipelinesRepository,
  TasksRepository,
} from '@/domain/repositories/crm-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025). Never a contact's values. */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType:
    | 'account'
    | 'contact'
    | 'pipeline'
    | 'list-entry'
    | 'opportunity'
    | 'activity'
    | 'task'
    | 'note'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export abstract class AuditTrail {
  abstract append(record: AuditRecord): Promise<void>
}

export interface CrmScope {
  readonly tenantId: string
  readonly accounts: AccountsRepository
  readonly contacts: ContactsRepository
  readonly owners: OwnersRepository
  readonly pipelines: PipelinesRepository
  readonly lists: ListEntriesRepository
  readonly opportunities: OpportunitiesRepository
  readonly activities: ActivitiesRepository
  readonly tasks: TasksRepository
  readonly notes: NotesRepository
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

export abstract class CrmUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: CrmScope) => Promise<T>): Promise<T>

  /** Run a committing command at most once per idempotency key (ADR 0028). */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: CrmScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>

  /** Handle an event at most once per source and id, in one transaction with its effect. */
  abstract processEvent<T>(
    tenantId: string,
    event: ReceivedEvent,
    work: (scope: CrmScope) => Promise<T>,
  ): Promise<EventOutcome<T>>
}
