import type { Account } from '../entities/account'
import type { Activity } from '../entities/activity'
import type { Contact } from '../entities/contact'
import type { ListEntry } from '../entities/list-entry'
import type { Note } from '../entities/note'
import type { Opportunity, RecordedFact } from '../entities/opportunity'
import type { Pipeline } from '../entities/pipeline'
import type { Task } from '../entities/task'
import type { MetricRows } from '../services/opportunity-metrics'
import type { ListKind } from '../value-objects/crm-values'

export abstract class AccountsRepository {
  abstract findById(id: string): Promise<Account | null>
  abstract create(account: Account): Promise<void>
  abstract save(account: Account): Promise<void>
}

export abstract class ContactsRepository {
  abstract findById(id: string): Promise<Contact | null>
  /** Every contact of the account that is not erased yet, for shredding with its party. */
  abstract findLiveOf(accountId: string): Promise<readonly Contact[]>
  /** Creates the contact's own data key together with the sealed row. */
  abstract create(contact: Contact): Promise<void>
  /** Saving an erased contact destroys its key (ADR 0026). */
  abstract save(contact: Contact): Promise<void>
}

/**
 * A workspace user as CRM knows it: an id and whether it may still be given accounts.
 * No name and no email — Identity publishes neither, and CRM has no reason to hold them.
 */
export interface Owner {
  readonly userId: string
  readonly active: boolean
}

export abstract class OwnersRepository {
  abstract find(userId: string): Promise<Owner | null>
  /** Known from now on; a registration never re-enables a user already disabled. */
  abstract register(userId: string, at: Date): Promise<void>
  abstract disable(userId: string, at: Date): Promise<void>
}

export abstract class PipelinesRepository {
  abstract findById(id: string): Promise<Pipeline | null>
  abstract create(pipeline: Pipeline): Promise<void>
  abstract save(pipeline: Pipeline): Promise<void>
}

export abstract class ListEntriesRepository {
  abstract findById(id: string): Promise<ListEntry | null>
  /** An active entry of the list with this name, compared without case. */
  abstract findActiveByName(kind: ListKind, name: string): Promise<ListEntry | null>
  abstract create(entry: ListEntry): Promise<void>
  abstract save(entry: ListEntry): Promise<void>
}

export abstract class OpportunitiesRepository {
  abstract findById(id: string): Promise<Opportunity | null>
  /** The full history, in order: what the current state is the fold of. */
  abstract history(id: string): Promise<readonly RecordedFact[]>
  /** Appends the pending facts to the history and writes their fold, in one transaction. */
  abstract create(opportunity: Opportunity): Promise<void>
  abstract save(opportunity: Opportunity): Promise<void>
  /** Ids after `after`, in id order: one batch of a walk through every opportunity. */
  abstract idsAfter(after: string | null, limit: number): Promise<readonly string[]>
}

/**
 * The forecast and pipeline-metric rows of each opportunity (Phase 59). Saving an
 * opportunity replaces them with its history; a rebuild compares and replaces them.
 */
export abstract class MetricsRepository {
  abstract stored(opportunityId: string): Promise<MetricRows>
  abstract replace(opportunityId: string, rows: MetricRows): Promise<void>
}

/**
 * Activities, tasks and notes seal their text under the account's key (Phase 57): the
 * repository creates the key with the account's first record and never returns the text
 * of an erased account.
 */
export abstract class ActivitiesRepository {
  abstract findById(id: string): Promise<Activity | null>
  abstract create(activity: Activity): Promise<void>
  abstract save(activity: Activity): Promise<void>
}

export abstract class TasksRepository {
  abstract findById(id: string): Promise<Task | null>
  /** The account's open tasks, to cancel with its party. */
  abstract findOpenOf(accountId: string): Promise<readonly Task[]>
  /**
   * Open tasks whose reminder is due and was not sent, locked for this transaction and
   * skipped by any other that already holds them: a reminder is claimed by one sender.
   */
  abstract claimDueReminders(now: Date, limit: number): Promise<readonly Task[]>
  abstract create(task: Task): Promise<void>
  abstract save(task: Task): Promise<void>
}

export abstract class NotesRepository {
  abstract findById(id: string): Promise<Note | null>
  /** Writes the note and its first revision. */
  abstract create(note: Note): Promise<void>
  /** Appends the new revisions; nothing already written changes. */
  abstract save(note: Note): Promise<void>
}

/** A Sales quote made for an opportunity, as CRM last heard of it (Phase 58). */
export interface QuoteLink {
  readonly opportunityId: string
  readonly quoteRoot: string
  readonly quoteId: string
  readonly quoteVersion: number
  readonly status: 'sent' | 'accepted' | 'rejected'
  /** A rejection does not repeat the total; the one already known is kept. */
  readonly total: { readonly amount: string; readonly currency: string } | null
  readonly seenAt: Date
}

export abstract class OpportunityQuotesRepository {
  /**
   * Keep the latest version of each offer and what happened to it: an older version, or an
   * earlier state of the same version, never overwrites what is already known.
   */
  abstract record(link: QuoteLink): Promise<void>
}
