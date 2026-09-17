import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Account, type AccountKind } from '@/domain/entities/account'
import { type EntryDirection, JournalEntry } from '@/domain/entities/journal-entry'
import {
  AccountName,
  BankDetails,
  BusinessDate,
  Currency,
  Money,
} from '@/domain/value-objects/treasury-values'
import type { Clock } from '../ports/clock'
import type { TreasuryUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'

export interface OpenAccountInput {
  readonly kind: AccountKind
  readonly name: string
  readonly currency: string
  readonly bank?:
    | { readonly bankCode: string; readonly branch: string; readonly accountNumber: string }
    | undefined
  readonly openedOn: string
  readonly openingBalance: { readonly amount: string; readonly direction: EntryDirection }
}

interface ParsedAccount {
  name: AccountName
  currency: Currency
  bank: BankDetails | null
  openedOn: BusinessDate
  opening: Money
}

function parse(input: OpenAccountInput): Either<InvalidInputError, ParsedAccount> {
  const name = AccountName.create(input.name)
  if (name.isLeft()) return left(name.value)
  const currency = Currency.create(input.currency)
  if (currency.isLeft()) return left(currency.value)
  const bank: Either<InvalidInputError, BankDetails | null> =
    input.kind === 'bank' && input.bank ? BankDetails.create(input.bank) : right(null)
  if (bank.isLeft()) return left(bank.value)
  const openedOn = BusinessDate.create(input.openedOn, '/openedOn')
  if (openedOn.isLeft()) return left(openedOn.value)
  const opening = Money.create(
    input.openingBalance.amount,
    currency.value,
    '/openingBalance/amount',
  )
  if (opening.isLeft()) return left(opening.value)
  return right({
    name: name.value,
    currency: currency.value,
    bank: bank.value,
    openedOn: openedOn.value,
    opening: opening.value,
  })
}

/**
 * Open an account and record its opening balance as the first journal entry, dated the
 * day the account starts being tracked. A zero opening balance records nothing.
 */
export class OpenAccountUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    account: OpenAccountInput
  }): Outcome<{ id: string }> {
    const parsed = parse(request.account)
    if (parsed.isLeft()) return left(parsed.value)
    const { context } = request
    const values = parsed.value
    return once(this.unitOfWork, context, 'account.open', request.account, async (scope) => {
      if (await scope.accounts.findByName(values.name.value))
        return left(new ConflictError('an account with this name already exists'))
      const now = this.clock.now()
      const account = Account.open({
        tenantId: context.tenantId,
        kind: request.account.kind,
        name: values.name,
        currency: values.currency,
        bank: values.bank,
        openedOn: values.openedOn,
        now,
      })
      await scope.accounts.create(account)
      if (!values.opening.isZero()) {
        const opening = JournalEntry.record({
          tenantId: context.tenantId,
          accountId: account.id.toString(),
          direction: request.account.openingBalance.direction,
          amount: values.opening,
          valueOn: values.openedOn,
          source: 'opening',
          transferId: null,
          reverses: null,
          counterparty: null,
          memo: null,
          reason: null,
          now,
        })
        if (opening.isLeft()) return left(opening.value)
        await scope.journal.append([opening.value])
      }
      await audit(scope, context, {
        action: 'account.opened',
        subjectType: 'account',
        subjectId: account.id.toString(),
        occurredAt: now,
        details: {
          kind: request.account.kind,
          currency: values.currency.value,
          openingBalance: values.opening.amount,
          openingDirection: request.account.openingBalance.direction,
        },
      })
      return right({ id: account.id.toString() })
    })
  }
}

/** Deactivating stops new entries; the account and its journal stay readable. */
export class ChangeAccountStatusUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    accountId: string
    active: boolean
  }): Promise<Either<Failure, void>> {
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope) => {
      const [account] = await scope.accounts.findForUpdate([request.accountId])
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      const now = this.clock.now()
      const changed = account.changeStatus(request.active, now)
      if (changed.isLeft()) return left(changed.value)
      await scope.accounts.save(account)
      await audit(scope, request.context, {
        action: request.active ? 'account.activated' : 'account.deactivated',
        subjectType: 'account',
        subjectId: request.accountId,
        occurredAt: now,
        details: {},
      })
      return right(undefined)
    })
  }
}
