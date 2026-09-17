import type { AccountingPeriod } from '../entities/accounting-period'
import type { JournalTransaction } from '../entities/journal-transaction'
import type { LedgerAccount } from '../entities/ledger-account'

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
