import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Account } from '@/domain/entities/account'
import { type Subject, subjectOf } from '@/domain/value-objects/record-values'
import type { CrmScope } from '../ports/unit-of-work'

export type Failure = InvalidInputError | ConflictError | ResourceNotFoundError

export interface SubjectInput {
  readonly type: string
  readonly id: string
}

/**
 * The account a new record belongs to, taken from its subject and never from the request:
 * a contact's account, an opportunity's account, or the account itself. A record is
 * added only while that account is active and the subject is live (Phase 57).
 */
export async function accountOfSubject(
  scope: CrmScope,
  input: SubjectInput,
): Promise<Either<Failure, { subject: Subject; account: Account }>> {
  const parsed = subjectOf(input.type, input.id)
  if (parsed.isLeft()) return left(parsed.value)
  const subject = parsed.value
  let accountId = subject.id
  if (subject.type === 'contact') {
    const contact = await scope.contacts.findById(subject.id)
    if (!contact) return left(new ResourceNotFoundError('contact was not found'))
    if (contact.isErased()) return left(new ConflictError('the contact was erased'))
    accountId = contact.accountId
  }
  if (subject.type === 'opportunity') {
    const opportunity = await scope.opportunities.findById(subject.id)
    if (!opportunity) return left(new ResourceNotFoundError('opportunity was not found'))
    accountId = opportunity.state.accountId
  }
  const account = await scope.accounts.findById(accountId)
  if (!account) return left(new ResourceNotFoundError('account was not found'))
  if (!account.acceptsContacts())
    return left(new ConflictError('records are added only to an active account'))
  return right({ subject, account })
}

/**
 * An existing record may be changed while its account is not erased: an inactive account
 * still has work to finish, but an erased one has no readable text left to change.
 */
export async function liveAccount(
  scope: CrmScope,
  accountId: string,
): Promise<Either<Failure, Account>> {
  const account = await scope.accounts.findById(accountId)
  if (!account) return left(new ResourceNotFoundError('account was not found'))
  if (account.isErased()) return left(new ConflictError('the account was erased'))
  return right(account)
}
