import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  JournalRepository,
  LedgerAccountsRepository,
  PeriodsRepository,
} from '@/domain/repositories/ledger-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025, ADR 0042). */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType: 'account' | 'transaction' | 'period'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export abstract class AuditTrail {
  abstract append(record: AuditRecord): Promise<void>
}

export interface LedgerScope {
  readonly tenantId: string
  readonly accounts: LedgerAccountsRepository
  readonly journal: JournalRepository
  readonly periods: PeriodsRepository
  readonly audit: AuditTrail
  /** Serializes work on one month for the rest of the transaction, so a close cannot race a posting. */
  lockPeriod(period: string): Promise<void>
}

export interface CommandReceipt {
  readonly idempotencyKey: string
  readonly command: string
  readonly fingerprint: string
}

export abstract class LedgerUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: LedgerScope) => Promise<T>): Promise<T>

  /** Run a posting command at most once per idempotency key (ADR 0028). */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: LedgerScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>
}
