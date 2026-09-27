import type { CheckName, Figures, ReportName } from '@/domain/reports'

/** Amounts are minor units as decimal strings; counts are integers (ADR 0010). */
export interface CashPosition {
  readonly receivables: readonly { readonly currency: string; readonly outstanding: string }[]
  readonly payables: readonly { readonly currency: string; readonly outstanding: string }[]
  readonly accounts: readonly {
    readonly accountId: string
    readonly currency: string
    readonly balance: string
  }[]
}

export interface TitlesFlow {
  readonly raised: string
  readonly settled: string
  readonly open: string
}

export interface OrderToCash {
  readonly currencies: readonly {
    readonly currency: string
    readonly confirmed: { readonly count: number; readonly total: string }
    readonly cancelledAfterConfirmation: number
    readonly shipped: string
    readonly returned: string
    readonly receivables: TitlesFlow
    readonly bankReconciled: string
  }[]
}

export interface ProcureToPay {
  readonly currencies: readonly {
    readonly currency: string
    readonly committed: { readonly count: number; readonly total: string }
    readonly cancelledAfterApproval: number
    readonly received: string
    readonly returns: number
    readonly payables: TitlesFlow
  }[]
}

export interface PipelineToRevenue {
  readonly months: readonly {
    readonly month: string
    readonly currency: string
    readonly won: { readonly count: number; readonly value: string }
    readonly lost: { readonly count: number; readonly value: string }
    readonly converted: { readonly count: number; readonly value: string }
  }[]
  readonly quotesAccepted: readonly {
    readonly currency: string
    readonly count: number
    readonly total: string
  }[]
}

export interface ReportData {
  readonly 'cash-position': CashPosition
  readonly 'order-to-cash': OrderToCash
  readonly 'procure-to-pay': ProcureToPay
  readonly 'pipeline-to-revenue': PipelineToRevenue
}

type AnyReport = ReportData[ReportName]

const byKey = <T>(rows: readonly T[], entries: (row: T) => [string, string][]): Figures =>
  Object.fromEntries(rows.flatMap(entries))

/** What a report says for one check, in the shape its owner's figures are read into. */
export function reportedFigures(check: CheckName, data: AnyReport): Figures {
  switch (check) {
    case 'receivables-outstanding':
      return byKey((data as CashPosition).receivables, (row) => [[row.currency, row.outstanding]])
    case 'payables-outstanding':
      return byKey((data as CashPosition).payables, (row) => [[row.currency, row.outstanding]])
    case 'account-balances':
      return byKey((data as CashPosition).accounts, (row) => [[row.accountId, row.balance]])
    case 'orders-confirmed':
      return byKey((data as OrderToCash).currencies, (row) => [
        [`${row.currency}:count`, String(row.confirmed.count)],
        [`${row.currency}:total`, row.confirmed.total],
      ])
    case 'orders-committed':
      return byKey((data as ProcureToPay).currencies, (row) => [
        [`${row.currency}:count`, String(row.committed.count)],
        [`${row.currency}:total`, row.committed.total],
      ])
    case 'won-by-month':
      return byKey((data as PipelineToRevenue).months, (row) => [
        [`${row.month}:${row.currency}:count`, String(row.won.count)],
        [`${row.month}:${row.currency}:value`, row.won.value],
      ])
  }
}
