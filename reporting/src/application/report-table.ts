import { amountOf, type Cell, type Table } from '@/domain/exports'
import type { ReportName } from '@/domain/reports'
import type {
  CashPosition,
  OrderToCash,
  PipelineToRevenue,
  ProcureToPay,
  ReportData,
} from './report-data'

/**
 * A report as one table of rows, the shape both CSV and XLSX write (Phase 63). Column
 * names are machine names and are never localized (ADR 0044); amounts are decimal amounts
 * of their currency.
 */
function cashPosition(data: CashPosition): Table {
  const rows: Cell[][] = [
    ...data.receivables.map((row) => [
      'receivables',
      row.currency,
      row.currency,
      amountOf(row.outstanding, row.currency),
    ]),
    ...data.payables.map((row) => [
      'payables',
      row.currency,
      row.currency,
      amountOf(row.outstanding, row.currency),
    ]),
    ...data.accounts.map((row) => [
      'account',
      row.accountId,
      row.currency,
      amountOf(row.balance, row.currency),
    ]),
  ]
  return { columns: ['section', 'key', 'currency', 'amount'], rows }
}

function orderToCash(data: OrderToCash): Table {
  return {
    columns: [
      'currency',
      'confirmed_count',
      'confirmed_total',
      'cancelled_after_confirmation',
      'shipped',
      'returned',
      'receivables_raised',
      'receivables_settled',
      'receivables_open',
      'bank_reconciled',
    ],
    rows: data.currencies.map((row) => {
      const money = (minor: string) => amountOf(minor, row.currency)
      return [
        row.currency,
        row.confirmed.count,
        money(row.confirmed.total),
        row.cancelledAfterConfirmation,
        money(row.shipped),
        money(row.returned),
        money(row.receivables.raised),
        money(row.receivables.settled),
        money(row.receivables.open),
        money(row.bankReconciled),
      ]
    }),
  }
}

function procureToPay(data: ProcureToPay): Table {
  return {
    columns: [
      'currency',
      'committed_count',
      'committed_total',
      'cancelled_after_approval',
      'received',
      'returns',
      'payables_raised',
      'payables_settled',
      'payables_open',
    ],
    rows: data.currencies.map((row) => {
      const money = (minor: string) => amountOf(minor, row.currency)
      return [
        row.currency,
        row.committed.count,
        money(row.committed.total),
        row.cancelledAfterApproval,
        money(row.received),
        row.returns,
        money(row.payables.raised),
        money(row.payables.settled),
        money(row.payables.open),
      ]
    }),
  }
}

function pipelineToRevenue(data: PipelineToRevenue): Table {
  const months: Cell[][] = data.months.map((row) => {
    const money = (minor: string) => amountOf(minor, row.currency)
    return [
      'month',
      row.month,
      row.currency,
      row.won.count,
      money(row.won.value),
      row.lost.count,
      money(row.lost.value),
      row.converted.count,
      money(row.converted.value),
      null,
      null,
    ]
  })
  const quotes: Cell[][] = data.quotesAccepted.map((row) => [
    'quotes-accepted',
    null,
    row.currency,
    null,
    null,
    null,
    null,
    null,
    null,
    row.count,
    amountOf(row.total, row.currency),
  ])
  return {
    columns: [
      'section',
      'month',
      'currency',
      'won_count',
      'won_value',
      'lost_count',
      'lost_value',
      'converted_count',
      'converted_value',
      'quotes_count',
      'quotes_total',
    ],
    rows: [...months, ...quotes],
  }
}

export function reportTable<N extends ReportName>(name: N, data: ReportData[N]): Table {
  switch (name) {
    case 'cash-position':
      return cashPosition(data as CashPosition)
    case 'order-to-cash':
      return orderToCash(data as OrderToCash)
    case 'procure-to-pay':
      return procureToPay(data as ProcureToPay)
    default:
      return pipelineToRevenue(data as PipelineToRevenue)
  }
}
