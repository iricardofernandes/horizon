import type { Account } from '../entities/account'
import type { JournalEntry } from '../entities/journal-entry'
import type { Transfer } from '../entities/transfer'

export abstract class AccountsRepository {
  /** Loads the accounts and locks them, in id order so two transfers never deadlock. */
  abstract findForUpdate(ids: readonly string[]): Promise<readonly Account[]>
  abstract findByName(name: string): Promise<Account | null>
  abstract create(account: Account): Promise<void>
  abstract save(account: Account): Promise<void>
}

export abstract class JournalRepository {
  abstract findById(id: string): Promise<JournalEntry | null>
  abstract findReversalOf(id: string): Promise<JournalEntry | null>
  abstract findLegsOf(transferId: string): Promise<readonly JournalEntry[]>
  /** Appends the entries and publishes their events in the same transaction. */
  abstract append(entries: readonly JournalEntry[]): Promise<void>
}

export abstract class TransfersRepository {
  abstract findForUpdate(id: string): Promise<Transfer | null>
  abstract create(transfer: Transfer): Promise<void>
  abstract save(transfer: Transfer): Promise<void>
}
