import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { type AccountType, LedgerAccount } from '@/domain/entities/ledger-account'
import { AccountCode, AccountName, Currency } from '@/domain/value-objects/ledger-values'
import type { Clock } from '../ports/clock'
import type { LedgerUnitOfWork } from '../ports/unit-of-work'
import {
  audit,
  type CommandContext,
  type Failure,
  type IdempotentContext,
  type Outcome,
  once,
} from './commands'

export interface OpenAccountInput {
  readonly code: string
  readonly name: string
  readonly type: AccountType
  readonly postable: boolean
  readonly currency: string
}

interface ParsedAccount {
  code: AccountCode
  name: AccountName
  currency: Currency
}

function parse(input: OpenAccountInput): Either<InvalidInputError, ParsedAccount> {
  const code = AccountCode.create(input.code)
  if (code.isLeft()) return left(code.value)
  const name = AccountName.create(input.name)
  if (name.isLeft()) return left(name.value)
  const currency = Currency.create(input.currency)
  if (currency.isLeft()) return left(currency.value)
  return right({ code: code.value, name: name.value, currency: currency.value })
}

/** The parent code of `1.01.001` is `1.01`; a top-level code has none. */
function parentCodeOf(code: string): string | null {
  const groups = code.split('.')
  return groups.length === 1 ? null : groups.slice(0, -1).join('.')
}

/**
 * Add an account to the chart. Its place in the tree comes from its own code, so the
 * parent is looked up rather than supplied — a caller cannot file `1.01.001` under `4`.
 */
export class OpenAccountUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    account: OpenAccountInput
  }): Outcome<{ id: string; code: string }> {
    const parsed = parse(request.account)
    if (parsed.isLeft()) return left(parsed.value)
    const values = parsed.value
    const { context } = request
    return once(this.unitOfWork, context, 'account.open', request.account, async (scope) => {
      if (await scope.accounts.findByCode(values.code.value))
        return left(new ConflictError(`account ${values.code.value} already exists`))
      const parentCode = parentCodeOf(values.code.value)
      const parent = parentCode ? await scope.accounts.findByCode(parentCode) : null
      if (parentCode && !parent)
        return left(new ResourceNotFoundError(`parent account ${parentCode} was not found`))
      const now = this.clock.now()
      const opened = LedgerAccount.open({
        tenantId: context.tenantId,
        code: values.code,
        name: values.name,
        type: request.account.type,
        parent,
        postable: request.account.postable,
        currency: values.currency,
        now,
      })
      if (opened.isLeft()) return left(opened.value)
      await scope.accounts.create(opened.value)
      await audit(scope, context, {
        action: 'account.opened',
        subjectType: 'account',
        subjectId: opened.value.id.toString(),
        occurredAt: now,
        details: {
          code: values.code.value,
          type: request.account.type,
          postable: request.account.postable,
          currency: values.currency.value,
        },
      })
      return right({ id: opened.value.id.toString(), code: values.code.value })
    })
  }
}

/** Deactivating stops new lines; the account and everything already posted stay readable. */
export class ChangeAccountStatusUseCase {
  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: CommandContext
    accountId: string
    active: boolean
  }): Promise<Either<Failure, void>> {
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope) => {
      const account = await scope.accounts.findForUpdate(request.accountId)
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
        details: { code: account.code },
      })
      return right(undefined)
    })
  }
}
