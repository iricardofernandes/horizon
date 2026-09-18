export const LEDGER_API = '/api/horizon/ledger'
export const FINANCIAL_API = '/api/horizon/financial'

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export type ChartAccount = {
  id: string
  code: string
  name: string
  type: AccountType
  parentId: string | null
  postable: boolean
  currency: string
  active: boolean
  depth: number
  balance: string
  rollUp: string
}

export type StatementRow = {
  accountId: string
  code: string
  name: string
  type: 'revenue' | 'expense'
  depth: number
  postable: boolean
  amount: string
  rollUp: string
}

export type IncomeStatement = {
  from: string
  to: string
  revenue: StatementRow[]
  expense: StatementRow[]
  totalRevenue: string
  totalExpense: string
  result: string
}

export type CashFlowBucket = {
  startsOn: string
  inflow: string
  outflow: string
  net: string
  closing: string
}

export type CashFlow = {
  from: string
  to: string
  grain: Grain
  opening: string
  buckets: CashFlowBucket[]
  inflow: string
  outflow: string
  net: string
  closing: string
  accounts: { code: string; name: string }[]
}

export type OutlookBucket = {
  startsOn: string
  committedIn: string
  committedOut: string
  forecastIn: string
  forecastOut: string
  net: string
}

export type CashFlowOutlook = {
  from: string
  to: string
  grain: Grain
  buckets: OutlookBucket[]
  committedIn: string
  committedOut: string
  forecastIn: string
  forecastOut: string
  net: string
  overdueIn: string
  overdueOut: string
}

export type TrialBalanceRow = {
  accountId: string
  code: string
  name: string
  type: string
  currency: string
  opening: string
  debits: string
  credits: string
  closing: string
}

export type TrialBalance = {
  from: string
  to: string
  rows: TrialBalanceRow[]
  totalDebits: string
  totalCredits: string
}

export type LedgerLine = {
  transactionId: string
  lineNumber: number
  reference: string
  postedOn: string
  side: 'debit' | 'credit'
  amount: string
  memo: string | null
  status: string
  sourceType: string
  sourceId: string | null
  runningBalance: string
}

export type AccountLedger = {
  accountId: string
  code: string
  name: string
  currency: string
  opening: string
  closing: string
  data: LedgerLine[]
  total: number
}

export type PendingFact = {
  kind: string
  factId: string
  reference: string
  reason: string | null
  receivedAt: string
}

export const GRAINS = ['day', 'week', 'month'] as const
export type Grain = (typeof GRAINS)[number]

export type LedgerData = {
  chart: ChartAccount[]
  statement: IncomeStatement
  cashFlow: CashFlow
  outlook: CashFlowOutlook
  trial: TrialBalance
  pending: { data: PendingFact[]; total: number }
  range: { from: string; to: string }
  grain: Grain
}

/**
 * Where a ledger line came from, as somewhere a reader can actually go.
 *
 * A transaction names the fact it accounts for but not the module that owns it, and only
 * some of those facts have a screen. The ones that do get a link; the rest are named and
 * left alone rather than dressed up as links that go nowhere.
 */
export function sourceHref(line: Pick<LedgerLine, 'sourceType'>): string | null {
  switch (line.sourceType) {
    case 'receivable':
      return '/app/finance/receivables'
    case 'payable':
      return '/app/finance/payables'
    case 'settlement':
      return '/app/finance/receivables'
    case 'transfer':
    case 'treasury-entry':
      return '/app/finance/treasury'
    default:
      return null
  }
}

/** The calendar year so far, which is the range an accountant opens a report on. */
export function yearToDate(now = new Date()): { from: string; to: string } {
  const pad = (value: number) => String(value).padStart(2, '0')
  const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return { from: `${now.getFullYear()}-01-01`, to }
}

/** Debit accounts read positive when debited; the sign is already in the stored balance. */
export function isNegative(amount: string): boolean {
  return amount.startsWith('-')
}
