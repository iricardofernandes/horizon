import type { AccountMapping, PostingChart, PostingRole } from '../entities/account-mapping'
import type { AccountingPeriod } from '../entities/accounting-period'
import type { JournalTransaction } from '../entities/journal-transaction'
import type { LedgerAccount } from '../entities/ledger-account'
import type { Fact } from '../services/posting-rules'

export abstract class LedgerAccountsRepository {
  /** Loads accounts by id, in id order so two postings never deadlock on the same pair. */
  abstract findMany(ids: readonly string[]): Promise<readonly LedgerAccount[]>
  abstract findById(id: string): Promise<LedgerAccount | null>
  abstract findForUpdate(id: string): Promise<LedgerAccount | null>
  abstract findByCode(code: string): Promise<LedgerAccount | null>
  abstract create(account: LedgerAccount): Promise<void>
  abstract save(account: LedgerAccount): Promise<void>
}

export abstract class JournalRepository {
  abstract findForUpdate(id: string): Promise<JournalTransaction | null>
  /** Appends the transaction with its lines and publishes its events in one transaction. */
  abstract post(transaction: JournalTransaction): Promise<void>
  /** Records a reversal against the transaction it undoes. */
  abstract save(transaction: JournalTransaction): Promise<void>
}

export abstract class PeriodsRepository {
  abstract findForUpdate(period: string): Promise<AccountingPeriod | null>
  /** Is this month closed right now? A month with no record has never been closed. */
  abstract isClosed(period: string): Promise<boolean>
  abstract create(period: AccountingPeriod): Promise<void>
  abstract save(period: AccountingPeriod): Promise<void>
}

export abstract class MappingsRepository {
  /** Every mapping in force, ready to answer which account plays which part. */
  abstract chart(): Promise<PostingChart>
  abstract list(): Promise<readonly AccountMapping[]>
  abstract find(role: PostingRole, key: string | null): Promise<AccountMapping | null>
  abstract save(mapping: AccountMapping): Promise<void>
}

export type FactStatus = 'posted' | 'pending' | 'reversed' | 'ignored'

/**
 * What the ledger did with one fact another module reported.
 *
 * It is keyed by the fact's own identifier rather than by the event id, so a redelivery
 * under a new event id still resolves to the same posting. A fact the workspace has no
 * account for is kept `pending` with the numbers it arrived with, so adding the mapping
 * and replaying posts it — rather than the fact being lost or the queue being blocked.
 */
export interface PostingFactRecord {
  readonly kind: Fact['kind']
  readonly factId: string
  readonly status: FactStatus
  readonly transactionId: string | null
  readonly reference: string
  readonly reason: string | null
  readonly fact: Fact
  readonly receivedAt: Date
}

export abstract class PostingFactsRepository {
  abstract find(kind: Fact['kind'], factId: string): Promise<PostingFactRecord | null>
  abstract record(record: PostingFactRecord): Promise<void>
  abstract update(
    kind: Fact['kind'],
    factId: string,
    change: {
      status: FactStatus
      transactionId?: string | null
      reason?: string | null
    },
  ): Promise<void>
  abstract pending(limit: number): Promise<readonly PostingFactRecord[]>
}
