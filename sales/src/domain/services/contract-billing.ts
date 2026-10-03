import type { AgreedInstallment, DeliveredServiceLine } from '../events/sales-events'
import { BusinessDate, type Currency, Money, type Reason } from '../value-objects/sales-values'
import type { ContractRevision, SchedulePeriod } from './contract-schedule'

export const CREDIT_REASONS = ['not-provided', 'billing-error'] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]

/** Why a run leaves a contract's period alone this month. */
export const SKIP_REASONS = [
  'already-billed',
  'suspended',
  'cancelled',
  'not-due-yet',
  'nothing-to-bill',
] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

/** Why a run will not bill a period until a person acts. */
export const REFUSAL_REASONS = ['customer-inactive', 'service-unavailable'] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

const COMPETENCE = /^\d{4}-(0[1-9]|1[0-2])$/

export function isCompetence(value: string): boolean {
  return COMPETENCE.test(value)
}

/** The first day of a competence month. */
export function competenceStart(competence: string): BusinessDate {
  return BusinessDate.ofCalendar(new Date(`${competence}-01T00:00:00.000Z`))
}

export interface PeriodCredit {
  readonly reasonCode: CreditReason
  readonly reason: Reason
  readonly creditedOn: BusinessDate
  readonly by: string
  readonly at: Date
}

/**
 * One period as it was billed: the revision, lines, amounts and installments frozen at
 * that moment. Nothing about it changes afterwards; a mistake is corrected by a credit.
 */
export interface BilledPeriod {
  readonly id: string
  readonly competence: string
  readonly revision: number
  readonly startsOn: BusinessDate
  readonly endsOn: BusinessDate
  readonly issuedOn: BusinessDate
  readonly lines: readonly DeliveredServiceLine[]
  readonly value: Money
  readonly installments: readonly AgreedInstallment[]
  readonly runId: string | null
  readonly billedBy: string
  readonly billedAt: Date
  readonly credit: PeriodCredit | null
}

export type PeriodBilling =
  | { readonly kind: 'bill'; readonly period: SchedulePeriod }
  | { readonly kind: 'skip'; readonly reason: SkipReason; readonly period: SchedulePeriod }

/**
 * Whether a period can be billed on `today`: it is billable in the schedule, its billing
 * day has come, it has not been billed, and it bills something.
 */
export function billingOf(
  period: SchedulePeriod,
  billed: readonly BilledPeriod[],
  today: BusinessDate,
): PeriodBilling {
  if (billed.some((candidate) => candidate.competence === period.competence))
    return { kind: 'skip', reason: 'already-billed', period }
  if (period.excluded) return { kind: 'skip', reason: period.excluded, period }
  if (today.isBefore(period.billingOn)) return { kind: 'skip', reason: 'not-due-yet', period }
  if (period.amount.isZero()) return { kind: 'skip', reason: 'nothing-to-bill', period }
  return { kind: 'bill', period }
}

/** Every line of a revision at its price and quantity, each with its own entry id. */
export function billedLines(
  revision: ContractRevision,
  entryId: () => string,
): readonly DeliveredServiceLine[] {
  return revision.lines.map((line) => {
    const amount = line.unitPrice.multiply(line.quantity)
    return {
      entryId: entryId(),
      lineId: line.lineId,
      itemId: line.itemId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: amount,
      amount,
    }
  })
}

export function totalOf(lines: readonly DeliveredServiceLine[], currency: Currency): Money {
  return lines.reduce((sum, line) => sum.plus(line.amount), Money.fromAmount(0n, currency))
}

const SKIP_MESSAGES: Readonly<Record<SkipReason, string>> = {
  'already-billed': 'this period was already billed',
  suspended: 'the contract is suspended in this period',
  cancelled: 'the contract is cancelled from this period on',
  'not-due-yet': 'the billing day of this period has not come yet',
  'nothing-to-bill': 'this period bills nothing',
}

export function skipMessage(reason: SkipReason): string {
  return SKIP_MESSAGES[reason]
}

/** The wire form of a billed period, as stored and read back. */
export function billedSnapshot(billed: BilledPeriod) {
  const money = (value: { amount: bigint }) => value.amount.toString()
  return {
    id: billed.id,
    competence: billed.competence,
    revision: billed.revision,
    startsOn: billed.startsOn.value,
    endsOn: billed.endsOn.value,
    issuedOn: billed.issuedOn.value,
    value: money(billed.value),
    installments: billed.installments.map((installment) => ({
      number: installment.number,
      dueOn: installment.dueOn.value,
      amount: money(installment.amount),
    })),
    runId: billed.runId,
    billedBy: billed.billedBy,
    billedAt: billed.billedAt,
    lines: billed.lines.map((line) => ({
      entryId: line.entryId,
      lineId: line.lineId,
      itemId: line.itemId,
      description: line.description.value,
      quantity: line.quantity.toString(),
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
    credit: billed.credit
      ? {
          reasonCode: billed.credit.reasonCode,
          reason: billed.credit.reason.value,
          creditedOn: billed.credit.creditedOn.value,
          by: billed.credit.by,
          at: billed.credit.at,
        }
      : null,
  }
}

export const RUN_OUTCOMES = ['pending', 'billed', 'skipped', 'refused'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/** What a billing run did, or will do, to one contract of its month. */
export interface RunItem {
  readonly contractId: string
  readonly customerId: string
  readonly outcome: RunOutcome
  readonly reason: SkipReason | RefusalReason | null
  readonly billedPeriodId: string | null
  readonly decidedAt: Date | null
}

/** A billing run for one competence month, with an item per candidate contract. */
export interface BillingRun {
  readonly id: string
  readonly competence: string
  readonly status: 'running' | 'completed'
  readonly requestedBy: string
  readonly startedAt: Date
  readonly finishedAt: Date | null
  readonly items: readonly RunItem[]
}

export type NfseOutcome = 'authorized' | 'rejected' | 'cancelled'
