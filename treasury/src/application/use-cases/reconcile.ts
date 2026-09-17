import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Account } from '@/domain/entities/account'
import { JournalEntry } from '@/domain/entities/journal-entry'
import {
  type OpenItem,
  Reconciliation,
  type SuggestionReference,
} from '@/domain/entities/reconciliation'
import { SUGGESTION_WINDOW_DAYS, suggestMatches } from '@/domain/services/match-suggestions'
import { BusinessDate, Memo, Money, Reason } from '@/domain/value-objects/treasury-values'
import type { Clock } from '../ports/clock'
import type { TreasuryScope, TreasuryUnitOfWork } from '../ports/unit-of-work'
import { audit, type Failure, type IdempotentContext, type Outcome, once } from './commands'

export interface Pick {
  readonly id: string
  /** Unsigned minor units to apply; the whole unreconciled amount when absent. */
  readonly amount?: string | undefined
}

const abs = (value: bigint) => (value < 0n ? -value : value)

function shift(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

type Selection = { item: OpenItem; amount?: bigint | undefined }[]

async function selection(
  scope: TreasuryScope,
  lines: readonly Pick[],
  entries: readonly Pick[],
): Promise<Either<Failure, { lines: Selection; entries: Selection }>> {
  const foundLines = await scope.reconciliations.findLines(lines.map((pick) => pick.id))
  const foundEntries = await scope.reconciliations.findEntries(entries.map((pick) => pick.id))
  const amountOf = (pick: Pick) => (pick.amount === undefined ? undefined : BigInt(pick.amount))
  const lineItems: Selection = []
  for (const pick of lines) {
    const found = foundLines.find((row) => row.value.id === pick.id)
    if (!found) return left(new ResourceNotFoundError(`statement line ${pick.id} was not found`))
    const { value } = found
    lineItems.push({
      item: {
        id: value.id,
        accountId: value.accountId,
        date: value.postedOn,
        amount: value.amount,
        available: abs(value.amount) - found.applied,
      },
      amount: amountOf(pick),
    })
  }
  const entryItems: Selection = []
  for (const pick of entries) {
    const found = foundEntries.find((row) => row.value.id.toString() === pick.id)
    if (!found) return left(new ResourceNotFoundError(`entry ${pick.id} was not found`))
    entryItems.push({
      item: {
        id: pick.id,
        accountId: found.value.accountId,
        date: found.value.valueOn,
        amount: found.value.effect(),
        available: found.value.amount.amount - found.applied,
      },
      amount: amountOf(pick),
    })
  }
  return right({ lines: lineItems, entries: entryItems })
}

/** A period closed through a date freezes every reconciliation touching it. */
async function checkOpenPeriod(
  scope: TreasuryScope,
  accountId: string,
  dates: readonly string[],
): Promise<Either<ConflictError, void>> {
  const closure = await scope.closures.inForce(accountId)
  if (closure && dates.some((date) => date <= closure.through))
    return left(
      new ConflictError(
        `the reconciliation period is closed through ${closure.through}; reopen it first`,
      ),
    )
  return right(undefined)
}

async function accountOf(
  scope: TreasuryScope,
  accountId: string,
): Promise<Either<Failure, Account>> {
  await scope.lockAccount(accountId)
  const [account] = await scope.accounts.findForUpdate([accountId])
  return account ? right(account) : left(new ResourceNotFoundError('account was not found'))
}

const signedTotal = (items: Selection) =>
  items.reduce((sum, { item, amount }) => {
    const size = amount ?? item.available
    return sum + (item.amount < 0n ? -size : size)
  }, 0n)

/**
 * Confirm that bank lines and entries are the same movements. When they do not add up, the
 * person may ask for an explicit adjustment entry for the difference; nothing is forced to
 * balance silently. A suggestion is only a starting point: the confirmation records whether
 * it was accepted as proposed or corrected (ADR 0046).
 */
export class ConfirmMatchUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: IdempotentContext
    accountId: string
    statementLines: readonly Pick[]
    entries: readonly Pick[]
    adjustment?: { readonly valueOn: string; readonly memo?: string | undefined } | undefined
    suggestionKey?: string | undefined
  }): Outcome<{ id: string; adjustmentEntryId: string | null }> {
    const { context, ...fingerprint } = request
    return once(this.unitOfWork, context, 'reconciliation.match', fingerprint, (scope) =>
      this.confirm(scope, context, request),
    )
  }

  private async confirm(
    scope: TreasuryScope,
    context: IdempotentContext,
    request: Parameters<ConfirmMatchUseCase['execute']>[0],
  ): Outcome<{ id: string; adjustmentEntryId: string | null }> {
    const account = await accountOf(scope, request.accountId)
    if (account.isLeft()) return left(account.value)
    const selected = await selection(scope, request.statementLines, request.entries)
    if (selected.isLeft()) return left(selected.value)
    const { lines, entries } = selected.value
    const now = this.clock.now()
    const adjustment = await this.adjust(
      scope,
      context,
      account.value,
      lines,
      entries,
      request.adjustment,
      now,
    )
    if (adjustment.isLeft()) return left(adjustment.value)
    const allEntries = adjustment.value ? [...entries, adjustment.value.selection] : entries
    const dates = [...lines, ...allEntries].map(({ item }) => item.date)
    const period = await checkOpenPeriod(scope, request.accountId, dates)
    if (period.isLeft()) return left(period.value)
    const suggestion = await this.suggestion(scope, request.accountId, request.suggestionKey, dates)
    if (suggestion.isLeft()) return left(suggestion.value)
    const reconciliation = Reconciliation.match({
      tenantId: context.tenantId,
      accountId: request.accountId,
      currency: account.value.currency.value,
      statementLines: lines,
      entries: allEntries,
      suggestion: suggestion.value,
      actor: context.actor,
      now,
    })
    if (reconciliation.isLeft()) return left(reconciliation.value)
    await scope.reconciliations.create(reconciliation.value)
    await audit(scope, context, {
      action: 'reconciliation.matched',
      subjectType: 'reconciliation',
      subjectId: reconciliation.value.id.toString(),
      occurredAt: now,
      details: {
        accountId: request.accountId,
        statementLines: lines.map(({ item }) => item.id),
        entries: allEntries.map(({ item }) => item.id),
        suggestionKey: request.suggestionKey ?? null,
      },
    })
    return right({
      id: reconciliation.value.id.toString(),
      adjustmentEntryId: adjustment.value?.selection.item.id ?? null,
    })
  }

  /** An explicit entry for the difference, recorded only when the person asked for it. */
  private async adjust(
    scope: TreasuryScope,
    context: IdempotentContext,
    account: Account,
    lines: Selection,
    entries: Selection,
    request: { readonly valueOn: string; readonly memo?: string | undefined } | undefined,
    now: Date,
  ): Promise<Either<Failure, { selection: Selection[number] } | null>> {
    const difference = signedTotal(lines) - signedTotal(entries)
    if (difference === 0n || !request) return right(null)
    const valueOn = BusinessDate.create(request.valueOn, '/adjustment/valueOn')
    if (valueOn.isLeft()) return left(valueOn.value)
    const accepted = account.accepts(account.currency, valueOn.value)
    if (accepted.isLeft()) return left(accepted.value)
    const memo = Memo.create(request.memo, '/adjustment/memo')
    if (memo.isLeft()) return left(memo.value)
    const entry = JournalEntry.record({
      tenantId: context.tenantId,
      accountId: account.id.toString(),
      direction: difference > 0n ? 'inflow' : 'outflow',
      amount: Money.of(abs(difference), account.currency),
      valueOn: valueOn.value,
      source: 'manual',
      transferId: null,
      settlementId: null,
      reverses: null,
      counterparty: null,
      memo: memo.value,
      reason: null,
      now,
    })
    if (entry.isLeft()) return left(entry.value)
    await scope.journal.append([entry.value])
    return right({
      selection: {
        item: {
          id: entry.value.id.toString(),
          accountId: account.id.toString(),
          date: valueOn.value.value,
          amount: difference,
          available: abs(difference),
        },
      },
    })
  }

  /** The suggestion is recomputed now: one that no longer applies is not recorded as accepted. */
  private async suggestion(
    scope: TreasuryScope,
    accountId: string,
    key: string | undefined,
    dates: readonly string[],
  ): Promise<Either<ConflictError, SuggestionReference | null>> {
    if (!key) return right(null)
    const sorted = [...dates].sort()
    const range = {
      from: shift(sorted[0] ?? '1970-01-01', -2 * SUGGESTION_WINDOW_DAYS),
      to: shift(sorted.at(-1) ?? '1970-01-01', 2 * SUGGESTION_WINDOW_DAYS),
    }
    const candidates = await scope.reconciliations.openCandidates(accountId, range)
    const found = suggestMatches(candidates.lines, candidates.entries).find(
      (suggestion) => suggestion.key === key,
    )
    return found ? right(found) : left(new ConflictError('the suggestion no longer applies'))
  }
}

export class IgnoreStatementLinesUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    accountId: string
    statementLines: readonly Pick[]
    reason: string
  }): Outcome<{ id: string }> {
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context, ...fingerprint } = request
    return once(this.unitOfWork, context, 'reconciliation.ignore', fingerprint, async (scope) => {
      const account = await accountOf(scope, request.accountId)
      if (account.isLeft()) return left(account.value)
      const selected = await selection(scope, request.statementLines, [])
      if (selected.isLeft()) return left(selected.value)
      const period = await checkOpenPeriod(
        scope,
        request.accountId,
        selected.value.lines.map(({ item }) => item.date),
      )
      if (period.isLeft()) return left(period.value)
      const now = this.clock.now()
      const reconciliation = Reconciliation.ignore({
        tenantId: context.tenantId,
        accountId: request.accountId,
        currency: account.value.currency.value,
        statementLines: selected.value.lines,
        reason: reason.value,
        actor: context.actor,
        now,
      })
      if (reconciliation.isLeft()) return left(reconciliation.value)
      await scope.reconciliations.create(reconciliation.value)
      await audit(scope, context, {
        action: 'reconciliation.ignored',
        subjectType: 'reconciliation',
        subjectId: reconciliation.value.id.toString(),
        occurredAt: now,
        details: { accountId: request.accountId, reason: reason.value.value },
      })
      return right({ id: reconciliation.value.id.toString() })
    })
  }
}

export class UndoReconciliationUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    reconciliationId: string
    reason: string
  }): Outcome<{ id: string }> {
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context, ...fingerprint } = request
    return once(this.unitOfWork, context, 'reconciliation.undo', fingerprint, async (scope) => {
      const reconciliation = await scope.reconciliations.findForUpdate(request.reconciliationId)
      if (!reconciliation) return left(new ResourceNotFoundError('reconciliation was not found'))
      await scope.lockAccount(reconciliation.accountId)
      const period = await checkOpenPeriod(scope, reconciliation.accountId, [
        reconciliation.latestDate(),
      ])
      if (period.isLeft()) return left(period.value)
      const now = this.clock.now()
      const undone = reconciliation.undo(reason.value, context.actor, now)
      if (undone.isLeft()) return left(undone.value)
      await scope.reconciliations.save(reconciliation)
      await audit(scope, context, {
        action: 'reconciliation.undone',
        subjectType: 'reconciliation',
        subjectId: request.reconciliationId,
        occurredAt: now,
        details: { reason: reason.value.value },
      })
      return right({ id: request.reconciliationId })
    })
  }
}

/** A dismissed suggestion is never proposed again, and counts against the matcher's record. */
export class DismissSuggestionUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    context: { tenantId: string; actor: string; requestId: string | null }
    accountId: string
    key: string
    score: number
  }): Promise<Either<Failure, void>> {
    return this.unitOfWork.inTenant(request.context.tenantId, async (scope) => {
      const [account] = await scope.accounts.findForUpdate([request.accountId])
      if (!account) return left(new ResourceNotFoundError('account was not found'))
      await scope.reconciliations.dismiss(
        request.accountId,
        request.key,
        Math.max(0, Math.min(100, Math.round(request.score))),
        request.context.actor,
        this.clock.now(),
      )
      return right(undefined)
    })
  }
}

export class ClosePeriodUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    accountId: string
    through: string
  }): Outcome<{ id: string }> {
    const through = BusinessDate.create(request.through, '/through')
    if (through.isLeft()) return left(through.value)
    const { context, ...fingerprint } = request
    return once(this.unitOfWork, context, 'reconciliation.close', fingerprint, async (scope) => {
      const account = await accountOf(scope, request.accountId)
      if (account.isLeft()) return left(account.value)
      if (await scope.closures.inForce(request.accountId))
        return left(
          new ConflictError('a period is already closed; reopen it before closing another'),
        )
      const open = await scope.closures.openLinesThrough(request.accountId, through.value.value)
      if (open > 0)
        return left(
          new ConflictError(`${open} bank lines through this date are not reconciled or ignored`),
        )
      const now = this.clock.now()
      const id = new UniqueEntityID().toString()
      await scope.closures.close({
        id,
        accountId: request.accountId,
        through: through.value.value,
        closedBy: context.actor,
        closedAt: now,
      })
      await audit(scope, context, {
        action: 'reconciliation.period-closed',
        subjectType: 'closure',
        subjectId: id,
        occurredAt: now,
        details: { accountId: request.accountId, through: through.value.value },
      })
      return right({ id })
    })
  }
}

export class ReopenPeriodUseCase {
  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    context: IdempotentContext
    accountId: string
    reason: string
  }): Outcome<{ id: string }> {
    const reason = Reason.create(request.reason)
    if (reason.isLeft()) return left(reason.value)
    const { context, ...fingerprint } = request
    return once(this.unitOfWork, context, 'reconciliation.reopen', fingerprint, async (scope) => {
      await scope.lockAccount(request.accountId)
      const closure = await scope.closures.inForce(request.accountId)
      if (!closure) return left(new ConflictError('no reconciliation period is closed'))
      const now = this.clock.now()
      await scope.closures.reopen(closure.id, context.actor, reason.value.value, now)
      await audit(scope, context, {
        action: 'reconciliation.period-reopened',
        subjectType: 'closure',
        subjectId: closure.id,
        occurredAt: now,
        details: {
          accountId: request.accountId,
          through: closure.through,
          reason: reason.value.value,
        },
      })
      return right({ id: closure.id })
    })
  }
}
