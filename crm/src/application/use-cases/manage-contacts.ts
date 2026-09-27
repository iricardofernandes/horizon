import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Contact, type ContactDetails } from '@/domain/entities/contact'
import {
  ContactEmail,
  ContactName,
  ContactPhone,
  JobTitle,
  lawfulBasisOf,
} from '@/domain/value-objects/crm-values'
import type { Clock } from '../ports/clock'
import type { CrmScope, CrmUnitOfWork } from '../ports/unit-of-work'
import { audit, type CommandContext, type IdempotentContext, once } from './commands'

export interface ContactInput {
  readonly name: string
  readonly jobTitle?: string | null | undefined
  readonly email?: string | null | undefined
  readonly phone?: string | null | undefined
  readonly lawfulBasis: string
}

/** A blank optional field is absent, not invalid. */
function optional<T>(
  value: string | null | undefined,
  create: (present: string) => Either<InvalidInputError, T>,
): Either<InvalidInputError, T | null> {
  return value?.trim() ? create(value) : right(null)
}

function detailsOf(input: ContactInput): Either<InvalidInputError, ContactDetails> {
  const name = ContactName.create(input.name)
  if (name.isLeft()) return left(name.value)
  const jobTitle = optional(input.jobTitle, JobTitle.create)
  if (jobTitle.isLeft()) return left(jobTitle.value)
  const email = optional(input.email, ContactEmail.create)
  if (email.isLeft()) return left(email.value)
  const phone = optional(input.phone, ContactPhone.create)
  if (phone.isLeft()) return left(phone.value)
  const lawfulBasis = lawfulBasisOf(input.lawfulBasis)
  if (lawfulBasis.isLeft()) return left(lawfulBasis.value)
  return right({
    name: name.value,
    jobTitle: jobTitle.value,
    email: email.value,
    phone: phone.value,
    lawfulBasis: lawfulBasis.value,
  })
}

type Failure = InvalidInputError | ResourceNotFoundError | ConflictError

/** Record a person at an account. Retried with the same key, it records them once. */
export class CreateContactUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly context: IdempotentContext
    readonly accountId: string
    readonly contact: ContactInput
  }): Promise<Either<Failure, { contactId: string }>> {
    const details = detailsOf(request.contact)
    if (details.isLeft()) return left(details.value)
    const { context } = request
    return once(
      this.unitOfWork,
      context,
      'contact.create',
      { accountId: request.accountId, contact: request.contact },
      async (scope) => {
        const account = await scope.accounts.findById(request.accountId)
        if (!account) return left(new ResourceNotFoundError('account was not found'))
        if (!account.acceptsContacts())
          return left(new ConflictError('contacts are added only to an active account'))
        const now = this.clock.now()
        const contact = Contact.create({
          ...details.value,
          tenantId: context.tenantId,
          accountId: request.accountId,
          now,
        })
        await scope.contacts.create(contact)
        await audit(scope, context, {
          action: 'contact.created',
          subjectType: 'contact',
          subjectId: contact.id.toString(),
          occurredAt: now,
          details: { accountId: request.accountId, lawfulBasis: details.value.lawfulBasis },
        })
        return right({ contactId: contact.id.toString() })
      },
    )
  }
}

/** Load, change, save and audit one contact inside one tenant transaction. */
async function withContact<T>(
  unitOfWork: CrmUnitOfWork,
  context: CommandContext,
  contactId: string,
  change: (contact: Contact, now: Date) => Either<Failure, T>,
  record: (outcome: T) => { action: string; details: Readonly<Record<string, unknown>> } | null,
  clock: Clock,
): Promise<Either<Failure, T>> {
  return unitOfWork.inTenant(context.tenantId, async (scope: CrmScope) => {
    const contact = await scope.contacts.findById(contactId)
    if (!contact) return left(new ResourceNotFoundError('contact was not found'))
    const now = clock.now()
    const outcome = change(contact, now)
    if (outcome.isLeft()) return outcome
    const entry = record(outcome.value)
    if (!entry) return outcome
    await scope.contacts.save(contact)
    await audit(scope, context, {
      ...entry,
      subjectType: 'contact',
      subjectId: contactId,
      occurredAt: now,
    })
    return outcome
  })
}

export class ReviseContactUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    readonly context: CommandContext
    readonly contactId: string
    readonly contact: ContactInput
  }): Promise<Either<Failure, { changed: readonly string[] }>> {
    const details = detailsOf(request.contact)
    if (details.isLeft()) return Promise.resolve(left(details.value))
    return withContact(
      this.unitOfWork,
      request.context,
      request.contactId,
      (contact, now) => {
        const changed = contact.revise(details.value, now)
        return changed.isLeft() ? left(changed.value) : right({ changed: changed.value })
      },
      // Which fields changed is recorded; what they changed to never is.
      ({ changed }) =>
        changed.length ? { action: 'contact.revised', details: { changed } } : null,
      this.clock,
    )
  }
}

export class ChangeContactStatusUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    readonly context: CommandContext
    readonly contactId: string
    readonly active: boolean
  }): Promise<Either<Failure, void>> {
    return withContact(
      this.unitOfWork,
      request.context,
      request.contactId,
      (contact, now) => (request.active ? contact.reactivate(now) : contact.deactivate(now)),
      () => ({
        action: request.active ? 'contact.reactivated' : 'contact.deactivated',
        details: {},
      }),
      this.clock,
    )
  }
}

/** LGPD erasure of one contact (ADR 0026): its key is destroyed, its account is untouched. */
export class EraseContactUseCase {
  constructor(
    private readonly unitOfWork: CrmUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    readonly context: CommandContext
    readonly contactId: string
  }): Promise<Either<Failure, void>> {
    return withContact(
      this.unitOfWork,
      request.context,
      request.contactId,
      (contact, now) => contact.erase(now),
      () => ({ action: 'contact.erased', details: {} }),
      this.clock,
    )
  }
}
