import type { Account } from '../entities/account'
import type { Contact } from '../entities/contact'

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
