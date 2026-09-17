import type { Either } from '@/core/either'
import type { ConflictError } from '@/core/errors/errors/conflict-error'
import type {
  AccountsRepository,
  ClosuresRepository,
  JournalRepository,
  ReconciliationsRepository,
  StatementsRepository,
  TransfersRepository,
} from '@/domain/repositories/treasury-repositories'

/** One line in the tenant's hash-chained audit log (ADR 0025, ADR 0042). */
export interface AuditRecord {
  readonly actor: string
  readonly action: string
  readonly subjectType:
    | 'account'
    | 'entry'
    | 'transfer'
    | 'statement-import'
    | 'reconciliation'
    | 'closure'
  readonly subjectId: string
  readonly occurredAt: Date
  readonly requestId: string | null
  readonly details: Readonly<Record<string, unknown>>
}

export abstract class AuditTrail {
  abstract append(record: AuditRecord): Promise<void>
}

export interface TreasuryScope {
  readonly tenantId: string
  readonly accounts: AccountsRepository
  readonly journal: JournalRepository
  readonly transfers: TransfersRepository
  readonly statements: StatementsRepository
  readonly reconciliations: ReconciliationsRepository
  readonly closures: ClosuresRepository
  readonly audit: AuditTrail
  /** Serializes reconciliation work on one account for the rest of the transaction. */
  lockAccount(accountId: string): Promise<void>
}

export interface CommandReceipt {
  readonly idempotencyKey: string
  readonly command: string
  readonly fingerprint: string
}

export abstract class TreasuryUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: TreasuryScope) => Promise<T>): Promise<T>

  /** Run a money-moving command at most once per idempotency key (ADR 0028). */
  abstract once<E, T>(
    tenantId: string,
    receipt: CommandReceipt,
    work: (scope: TreasuryScope) => Promise<Either<E, T>>,
  ): Promise<Either<E | ConflictError, T>>
}
