import { type Either, left, right } from '@/core/either'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { JournalEntry } from '@/domain/entities/journal-entry'
import { BusinessDate, Currency, Money, Reason } from '@/domain/value-objects/treasury-values'
import type { Clock } from '../ports/clock'
import type { TreasuryScope } from '../ports/unit-of-work'

const FINANCIAL_ACTOR = 'system:financial'

export interface ReportedSettlement {
  readonly settlementId: string
  readonly titleId: string
  readonly direction: 'receivable' | 'payable'
  readonly settledOn: string
  readonly received: { readonly amount: string; readonly currency: string }
  readonly treasuryAccountId?: string | undefined
}

export type SettlementOutcome = 'posted' | 'refused' | 'ignored'

/**
 * A settlement Financial recorded against a treasury account becomes the account's journal
 * entry for the cash that moved: money received for a receivable, paid for a payable. When
 * the account cannot take it, the refusal is recorded with its reason instead of retried
 * forever, so the bank line it matches shows why nothing is there (ADR 0041).
 */
export class RecordSettlementEntryUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: TreasuryScope,
    settlement: ReportedSettlement,
  ): Promise<Either<InvalidInputError, SettlementOutcome>> {
    const accountId = settlement.treasuryAccountId
    if (!accountId || settlement.received.amount === '0') return right('ignored')
    if (await scope.settlements.find(settlement.settlementId)) return right('ignored')
    const now = this.clock.now()
    const refuse = async (reason: string) => {
      await scope.settlements.record({
        settlementId: settlement.settlementId,
        titleId: settlement.titleId,
        accountId,
        status: 'refused',
        entryId: null,
        reason,
        receivedAt: now,
      })
      return right<InvalidInputError, SettlementOutcome>('refused')
    }
    const currency = Currency.create(settlement.received.currency)
    if (currency.isLeft()) return left(currency.value)
    const amount = Money.create(settlement.received.amount, currency.value)
    if (amount.isLeft()) return left(amount.value)
    const valueOn = BusinessDate.create(settlement.settledOn, '/settledOn')
    if (valueOn.isLeft()) return left(valueOn.value)
    const [account] = await scope.accounts.findForUpdate([accountId])
    if (!account) return refuse('the treasury account does not exist in this workspace')
    const accepted = account.accepts(currency.value, valueOn.value)
    if (accepted.isLeft()) return refuse(accepted.value.message)
    const entry = JournalEntry.record({
      tenantId: scope.tenantId,
      accountId,
      direction: settlement.direction === 'receivable' ? 'inflow' : 'outflow',
      amount: amount.value,
      valueOn: valueOn.value,
      source: 'settlement',
      transferId: null,
      settlementId: settlement.settlementId,
      reverses: null,
      counterparty: null,
      memo: null,
      reason: null,
      now,
    })
    if (entry.isLeft()) return left(entry.value)
    await scope.journal.append([entry.value])
    await scope.settlements.record({
      settlementId: settlement.settlementId,
      titleId: settlement.titleId,
      accountId,
      status: 'posted',
      entryId: entry.value.id.toString(),
      reason: null,
      receivedAt: now,
    })
    await scope.audit.append({
      actor: FINANCIAL_ACTOR,
      action: 'entry.recorded',
      subjectType: 'entry',
      subjectId: entry.value.id.toString(),
      occurredAt: now,
      requestId: null,
      details: { accountId, settlementId: settlement.settlementId, amount: amount.value.amount },
    })
    return right('posted')
  }
}

/** A settlement reversed in Financial reverses the entry it produced, and nothing else. */
export class ReverseSettlementEntryUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: TreasuryScope,
    reversal: { readonly settlementId: string; readonly reason: string },
  ): Promise<Either<InvalidInputError, 'reversed' | 'ignored'>> {
    const posting = await scope.settlements.find(reversal.settlementId)
    if (!posting?.entryId) return right('ignored')
    const entry = await scope.journal.findById(posting.entryId)
    if (!entry || (await scope.journal.findReversalOf(posting.entryId))) return right('ignored')
    const reason = Reason.create(reversal.reason)
    if (reason.isLeft()) return left(reason.value)
    await scope.accounts.findForUpdate([posting.accountId])
    const now = this.clock.now()
    const inverse = entry.reverse(reason.value, now, { fromSettlement: true })
    if (inverse.isLeft()) return right('ignored')
    await scope.journal.append([inverse.value])
    await scope.audit.append({
      actor: FINANCIAL_ACTOR,
      action: 'entry.reversed',
      subjectType: 'entry',
      subjectId: posting.entryId,
      occurredAt: now,
      requestId: null,
      details: { settlementId: reversal.settlementId, reason: reason.value.value },
    })
    return right('reversed')
  }
}
