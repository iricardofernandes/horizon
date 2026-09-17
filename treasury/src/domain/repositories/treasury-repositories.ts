import type { DomainEvent } from '@/core/events/domain-event'
import type { Account } from '../entities/account'
import type { JournalEntry } from '../entities/journal-entry'
import type { Reconciliation } from '../entities/reconciliation'
import type { StatementLine } from '../entities/statement-line'
import type { Transfer } from '../entities/transfer'
import type { CandidateEntry, CandidateLine } from '../services/match-suggestions'

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

/** What Treasury did with one settlement Financial reported with an account. */
export interface SettlementPosting {
  readonly settlementId: string
  readonly titleId: string
  readonly accountId: string
  readonly status: 'posted' | 'refused'
  readonly entryId: string | null
  readonly reason: string | null
  readonly receivedAt: Date
}

export abstract class SettlementPostingsRepository {
  abstract find(settlementId: string): Promise<SettlementPosting | null>
  abstract record(posting: SettlementPosting): Promise<void>
}

export interface StatementImport {
  readonly id: string
  readonly accountId: string
  readonly format: 'ofx' | 'csv'
  readonly fileName: string
  readonly fileHash: string
  readonly lineCount: number
  readonly duplicateCount: number
  readonly periodStart: string | null
  readonly periodEnd: string | null
  readonly closingBalance: { readonly amount: bigint; readonly on: string } | null
  readonly importedBy: string
  readonly importedAt: Date
}

export abstract class StatementsRepository {
  abstract findImportByHash(accountId: string, fileHash: string): Promise<StatementImport | null>
  /** Which of these fingerprints the account already holds. */
  abstract knownFingerprints(
    accountId: string,
    fingerprints: readonly string[],
  ): Promise<Set<string>>
  abstract append(
    statementImport: StatementImport,
    lines: readonly StatementLine[],
    event: DomainEvent,
  ): Promise<void>
}

/** A line or entry with what reconciliations in force already applied to it. */
export interface Reconcilable<T> {
  readonly value: T
  /** Unsigned minor units applied by active reconciliations. */
  readonly applied: bigint
}

export abstract class ReconciliationsRepository {
  abstract findLines(ids: readonly string[]): Promise<readonly Reconcilable<StatementLine>[]>
  abstract findEntries(ids: readonly string[]): Promise<readonly Reconcilable<JournalEntry>[]>
  abstract findForUpdate(id: string): Promise<Reconciliation | null>
  abstract create(reconciliation: Reconciliation): Promise<void>
  abstract save(reconciliation: Reconciliation): Promise<void>
  abstract dismiss(
    accountId: string,
    key: string,
    score: number,
    actor: string,
    now: Date,
  ): Promise<void>
  abstract dismissedKeys(accountId: string): Promise<Set<string>>
  /** Lines and entries dated in the range that still have something unreconciled. */
  abstract openCandidates(
    accountId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<{ lines: CandidateLine[]; entries: CandidateEntry[] }>
}

export interface PeriodClosure {
  readonly id: string
  readonly accountId: string
  readonly through: string
  readonly closedBy: string
  readonly closedAt: Date
}

export abstract class ClosuresRepository {
  abstract inForce(accountId: string): Promise<PeriodClosure | null>
  abstract close(closure: PeriodClosure): Promise<void>
  abstract reopen(id: string, actor: string, reason: string, now: Date): Promise<void>
  /** Bank lines up to a date that no reconciliation in force fully accounts for. */
  abstract openLinesThrough(accountId: string, through: string): Promise<number>
}
