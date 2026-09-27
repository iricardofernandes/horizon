import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { Source } from './journal'

/**
 * The reports `reporting/` serves, what each reads, and how each of its figures is proven
 * (ADR 0058, Phase 62). A report is a query over the journal at a cutoff; a figure either
 * reconciles against its owner's own report, or says it is derived and from where.
 */
export const REPORT_NAMES = [
  'cash-position',
  'order-to-cash',
  'procure-to-pay',
  'pipeline-to-revenue',
] as const
export type ReportName = (typeof REPORT_NAMES)[number]

export const CHECK_NAMES = [
  'receivables-outstanding',
  'payables-outstanding',
  'account-balances',
  'orders-confirmed',
  'orders-committed',
  'won-by-month',
] as const
export type CheckName = (typeof CHECK_NAMES)[number]

export interface CheckDefinition {
  readonly name: CheckName
  readonly owner: Source
  /** The owner's route, through the gateway. */
  readonly path: string
  /**
   * True when the owner answers as of the cutoff itself. Otherwise it answers the current
   * state, which describes the cutoff only while nothing has happened in it since.
   */
  readonly asOfCutoff: boolean
}

export interface ReportDefinition {
  readonly name: ReportName
  readonly sources: readonly Source[]
  readonly checks: readonly CheckDefinition[]
  /** Figures with no owner aggregate: where they come from, and why they are not checked. */
  readonly derived: readonly { readonly figure: string; readonly from: Source }[]
}

const check = (
  name: CheckName,
  owner: Source,
  path: string,
  asOfCutoff = false,
): CheckDefinition => ({ name, owner, path, asOfCutoff })

export const REPORTS: Readonly<Record<ReportName, ReportDefinition>> = {
  'cash-position': {
    name: 'cash-position',
    sources: ['financial', 'treasury'],
    checks: [
      check('receivables-outstanding', 'financial', '/financial/receivables/summary'),
      check('payables-outstanding', 'financial', '/financial/payables/summary'),
      check('account-balances', 'treasury', '/treasury/accounts'),
    ],
    derived: [],
  },
  'order-to-cash': {
    name: 'order-to-cash',
    sources: ['sales', 'financial', 'treasury'],
    checks: [check('orders-confirmed', 'sales', '/sales/orders/summary')],
    derived: [
      { figure: 'shipped', from: 'sales' },
      { figure: 'returned', from: 'sales' },
      { figure: 'receivables', from: 'financial' },
      { figure: 'bankReconciled', from: 'treasury' },
    ],
  },
  'procure-to-pay': {
    name: 'procure-to-pay',
    sources: ['procurement', 'financial'],
    checks: [check('orders-committed', 'procurement', '/procurement/orders/summary')],
    derived: [
      { figure: 'received', from: 'procurement' },
      { figure: 'payables', from: 'financial' },
    ],
  },
  'pipeline-to-revenue': {
    name: 'pipeline-to-revenue',
    sources: ['crm', 'sales'],
    checks: [check('won-by-month', 'crm', '/crm/forecast', true)],
    derived: [
      { figure: 'converted', from: 'crm' },
      { figure: 'quotesAccepted', from: 'sales' },
    ],
  },
}

export function isReportName(value: string): value is ReportName {
  return (REPORT_NAMES as readonly string[]).includes(value)
}

/** A figure set: a key per currency, account or month, and a decimal string value. */
export type Figures = Readonly<Record<string, string>>

export interface Difference {
  readonly key: string
  readonly reported: string
  readonly owner: string
}

const ZERO = '0'

/** Every key where the two disagree. A key missing on one side counts as zero. */
export function differencesOf(reported: Figures, owner: Figures): Difference[] {
  const keys = [...new Set([...Object.keys(reported), ...Object.keys(owner)])].sort()
  return keys
    .map((key) => ({ key, reported: reported[key] ?? ZERO, owner: owner[key] ?? ZERO }))
    .filter((pair) => BigInt(pair.reported) !== BigInt(pair.owner))
}

export type NotComparableReason =
  | 'unsettled'
  | 'moved-after-cutoff'
  | 'owner-unavailable'
  | 'forbidden'

export type CheckResult =
  | { readonly check: CheckName; readonly outcome: 'matched' }
  | {
      readonly check: CheckName
      readonly outcome: 'different'
      readonly differences: readonly Difference[]
    }
  | {
      readonly check: CheckName
      readonly outcome: 'not-comparable'
      readonly reason: NotComparableReason
    }

export type RunOutcome = CheckResult['outcome']

export function checkResultOf(check: CheckName, reported: Figures, owner: Figures): CheckResult {
  const differences = differencesOf(reported, owner)
  return differences.length === 0
    ? { check, outcome: 'matched' }
    : { check, outcome: 'different', differences }
}

/** A difference outranks a check that could not be made; a run matches only if all do. */
export function runOutcomeOf(results: readonly CheckResult[]): RunOutcome {
  if (results.some((result) => result.outcome === 'different')) return 'different'
  if (results.some((result) => result.outcome === 'not-comparable')) return 'not-comparable'
  return 'matched'
}

export interface ReportFilter {
  readonly currency: string | null
  /** Months, `YYYY-MM`, bounding the flows; positions are never narrowed by them. */
  readonly from: string | null
  readonly to: string | null
}

export const NO_FILTER: ReportFilter = { currency: null, from: null, to: null }

const CURRENCY = /^[A-Z]{3}$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function reportFilterOf(input: {
  readonly currency?: string | null | undefined
  readonly from?: string | null | undefined
  readonly to?: string | null | undefined
}): Either<InvalidInputError, ReportFilter> {
  const currency = input.currency ?? null
  const from = input.from ?? null
  const to = input.to ?? null
  if (currency !== null && !CURRENCY.test(currency))
    return left(new InvalidInputError('currency', 'must be an ISO 4217 code'))
  if (from !== null && !MONTH.test(from))
    return left(new InvalidInputError('from', 'must be a month, YYYY-MM'))
  if (to !== null && !MONTH.test(to))
    return left(new InvalidInputError('to', 'must be a month, YYYY-MM'))
  if (from !== null && to !== null && from > to)
    return left(new InvalidInputError('from', 'must not be after to'))
  return right({ currency, from, to })
}

/** A cutoff is an instant already past; a report of the future would change. */
export function cutoffOf(requested: Date | null, now: Date): Either<InvalidInputError, Date> {
  const cutoff = requested ?? now
  if (Number.isNaN(cutoff.getTime()))
    return left(new InvalidInputError('cutoff', 'must be an ISO 8601 instant'))
  if (cutoff.getTime() > now.getTime())
    return left(new InvalidInputError('cutoff', 'must not be in the future'))
  return right(cutoff)
}
