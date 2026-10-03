import {
  BusinessDate,
  type Currency,
  type LineDescription,
  Money,
  type Quantity,
  type Reason,
} from '../value-objects/sales-values'

export const RECURRENCES = ['monthly', 'quarterly', 'yearly'] as const
export type Recurrence = (typeof RECURRENCES)[number]

export const MONTHS_OF: Readonly<Record<Recurrence, number>> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

/** The most periods one schedule read returns: twenty years of monthly billing. */
export const MAX_PERIODS = 240

export interface ContractLine {
  readonly lineId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly quantity: Quantity
  readonly unitPrice: Money
}

export const REVISION_KINDS = ['initial', 'amendment', 'renewal'] as const
export type RevisionKind = (typeof REVISION_KINDS)[number]

/** One immutable version of what a contract bills, from a period start onward. */
export interface ContractRevision {
  readonly number: number
  readonly kind: RevisionKind
  readonly effectiveFrom: BusinessDate
  readonly recurrence: Recurrence
  readonly lines: readonly ContractLine[]
  readonly readjustmentBasisPoints: number | null
  readonly reason: Reason | null
  readonly createdBy: string
  readonly createdAt: Date
}

export interface Suspension {
  readonly id: string
  readonly from: BusinessDate
  readonly until: BusinessDate | null
  readonly reason: Reason
  readonly createdBy: string
  readonly createdAt: Date
}

/** Everything the period grid depends on. */
export interface ScheduleTerms {
  readonly currency: Currency
  readonly startsOn: BusinessDate
  readonly endsOn: BusinessDate | null
  readonly billingDay: number
  readonly revisions: readonly ContractRevision[]
  readonly suspensions: readonly Suspension[]
  readonly cancelledFrom: BusinessDate | null
}

export interface SchedulePeriod {
  readonly index: number
  readonly startsOn: BusinessDate
  readonly endsOn: BusinessDate
  /** `YYYY-MM` of the period's first month: the competence of its billed period. */
  readonly competence: string
  /** The day Phase 52 bills it; due dates follow the payment terms from here. */
  readonly billingOn: BusinessDate
  readonly revision: number
  readonly amount: Money
  readonly billable: boolean
  readonly excluded: 'suspended' | 'cancelled' | null
}

export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [year = 0, month = 1, day = 1] = date.value.split('-').map(Number)
  const moved = new Date(Date.UTC(year, month - 1 + months, day))
  return BusinessDate.ofCalendar(moved)
}

export function isFirstOfMonth(date: BusinessDate): boolean {
  return date.value.endsWith('-01')
}

/**
 * The revision in force for a period that starts on `day`: the latest to take effect on
 * or before it, and of two taking effect on the same day, the later one.
 */
export function revisionAt(
  revisions: readonly ContractRevision[],
  day: BusinessDate,
): ContractRevision | null {
  let found: ContractRevision | null = null
  for (const revision of revisions) {
    if (day.isBefore(revision.effectiveFrom)) continue
    if (
      !found ||
      found.effectiveFrom.isBefore(revision.effectiveFrom) ||
      (found.effectiveFrom.value === revision.effectiveFrom.value && revision.number > found.number)
    )
      found = revision
  }
  return found
}

/** What one period of a revision bills: every line at its price and quantity. */
export function amountOf(revision: ContractRevision, currency: Currency): Money {
  return revision.lines.reduce(
    (sum, line) => sum.plus(line.unitPrice.multiply(line.quantity)),
    Money.fromAmount(0n, currency),
  )
}

/**
 * Walks the period grid from the start. Each period is as long as the recurrence of the
 * revision in force at its start, so a change of recurrence re-anchors the grid there.
 * The walk stops after the end date, or at `limit` periods.
 */
export function* periodStarts(
  terms: Pick<ScheduleTerms, 'startsOn' | 'endsOn' | 'revisions'>,
  limit = MAX_PERIODS * 10,
): Generator<{
  index: number
  startsOn: BusinessDate
  endsOn: BusinessDate
  revision: ContractRevision
}> {
  let start = terms.startsOn
  for (let index = 0; index < limit; index += 1) {
    if (terms.endsOn?.isBefore(start)) return
    const revision = revisionAt(terms.revisions, start)
    if (!revision) return
    const next = addMonths(start, MONTHS_OF[revision.recurrence])
    yield { index, startsOn: start, endsOn: next.plusDays(-1), revision }
    start = next
  }
}

/** Whether a day starts a period of the grid. */
export function isPeriodStart(
  terms: Pick<ScheduleTerms, 'startsOn' | 'endsOn' | 'revisions'>,
  day: BusinessDate,
): boolean {
  for (const period of periodStarts({ ...terms, endsOn: null })) {
    if (period.startsOn.value === day.value) return true
    if (day.isBefore(period.startsOn)) return false
  }
  return false
}

/** Whether a day ends a period of the grid (a valid end date). */
export function isPeriodEnd(
  terms: Pick<ScheduleTerms, 'startsOn' | 'revisions'>,
  day: BusinessDate,
): boolean {
  return isPeriodStart({ ...terms, endsOn: null }, day.plusDays(1))
}

/** The periods that overlap `[from, to]`, each with its revision, amount and billability. */
export function scheduleOf(
  terms: ScheduleTerms,
  range: { readonly from: BusinessDate; readonly to: BusinessDate },
): readonly SchedulePeriod[] {
  const periods: SchedulePeriod[] = []
  for (const period of periodStarts(terms)) {
    if (range.to.isBefore(period.startsOn) || periods.length >= MAX_PERIODS) break
    if (period.endsOn.isBefore(range.from)) continue
    const excluded = exclusionOf(terms, period.startsOn)
    const competence = period.startsOn.value.slice(0, 7)
    periods.push({
      index: period.index,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      competence,
      billingOn: BusinessDate.ofCalendar(
        new Date(`${competence}-${String(terms.billingDay).padStart(2, '0')}T00:00:00Z`),
      ),
      revision: period.revision.number,
      amount: amountOf(period.revision, terms.currency),
      billable: excluded === null,
      excluded,
    })
  }
  return periods
}

function exclusionOf(terms: ScheduleTerms, start: BusinessDate): 'suspended' | 'cancelled' | null {
  if (terms.cancelledFrom && !start.isBefore(terms.cancelledFrom)) return 'cancelled'
  const suspended = terms.suspensions.some(
    (suspension) =>
      !start.isBefore(suspension.from) && (!suspension.until || start.isBefore(suspension.until)),
  )
  return suspended ? 'suspended' : null
}

/** A price readjusted by basis points, rounded half-up to the minor unit. */
export function readjusted(price: Money, basisPoints: number): Money {
  const scaled = price.amount * BigInt(10_000 + basisPoints)
  return Money.fromAmount((scaled + 5_000n) / 10_000n, price.currency)
}
