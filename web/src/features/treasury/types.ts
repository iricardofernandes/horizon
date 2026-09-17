export const ACCOUNT_KINDS = ['bank', 'cash', 'card-clearing', 'virtual'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type TreasuryAccount = {
  id: string
  kind: AccountKind
  name: string
  currency: string
  bankCode: string | null
  branch: string | null
  accountNumber: string | null
  openedOn: string
  active: boolean
  bookBalance: string
  projectedBalance: string
  reconciledBalance: string
  statementBalance: string | null
  lastValueOn: string | null
  asOf: string
}

export type StatementLine = {
  id: string
  direction: 'inflow' | 'outflow'
  amount: string
  valueOn: string
  source: 'opening' | 'manual' | 'transfer' | 'transfer-fee' | 'reversal' | 'settlement'
  transferId: string | null
  reverses: string | null
  reversedBy: string | null
  counterparty: string | null
  memo: string | null
  reason: string | null
  recordedAt: string
  runningBalance: string
}

export type Statement = {
  from: string
  to: string
  openingBalance: string
  closingBalance: string
  total: number
  lines: StatementLine[]
}

export type TransferRow = {
  id: string
  fromAccountId: string
  fromAccountName: string
  toAccountId: string
  toAccountName: string
  amount: string
  fee: string | null
  currency: string
  valueOn: string
  memo: string | null
  status: 'posted' | 'cancelled'
  postedAt: string
  cancellationReason: string | null
}

export type TreasuryData = { accounts: TreasuryAccount[]; transfers: TransferRow[] }

export type TreasuryAbilities = { canConfigure: boolean; canRecord: boolean; canReverse: boolean }

export type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

export const TREASURY_API = '/api/horizon/treasury'

/** Signed minor units from the API: negative when the account is overdrawn. */
export function isNegative(amount: string): boolean {
  return amount.startsWith('-')
}

/** Only a manual entry that nobody reversed yet can be reversed by hand. */
export function reversible(line: StatementLine): boolean {
  return line.source === 'manual' && line.reversedBy === null
}

export function shiftDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
