'use client'

import { useCallback, useState } from 'react'
import { Resource } from '@/components/ui/resource'
import { LedgerView } from '@/features/ledger/ledger-view'
import {
  type CashFlow,
  type CashFlowOutlook,
  type ChartAccount,
  FINANCIAL_API,
  type Grain,
  type IncomeStatement,
  LEDGER_API,
  type PendingFact,
  type TrialBalance,
  yearToDate,
} from '@/features/ledger/types'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

/**
 * Every report is read for the same range, so the figures on the page are always answers to
 * the same question. The outlook comes from Financial and the rest from the Ledger: what is
 * expected and what actually happened are different modules' business, and composing them
 * here keeps it that way.
 */
export default function LedgerPage() {
  const [range, setRange] = useState(yearToDate)
  const [grain, setGrain] = useState<Grain>('month')

  const load = useCallback(async () => {
    const period = `from=${range.from}&to=${range.to}`
    const [chart, statement, cashFlow, outlook, trial, pending] = await Promise.all([
      readPage<ChartAccount>('ledger.chart', `${LEDGER_API}/accounts?asOf=${range.to}`),
      readJson<IncomeStatement>('ledger.statement', `${LEDGER_API}/income-statement?${period}`),
      readJson<CashFlow>('ledger.cashFlow', `${LEDGER_API}/cash-flow?${period}&grain=${grain}`),
      readJson<CashFlowOutlook>(
        'financial.outlook',
        `${FINANCIAL_API}/cash-flow-outlook?${period}&grain=${grain}`,
      ),
      readJson<TrialBalance>('ledger.trialBalance', `${LEDGER_API}/trial-balance?${period}`),
      readJson<{ data: PendingFact[]; total: number }>(
        'ledger.pending',
        `${LEDGER_API}/postings/pending?limit=20`,
      ),
    ])
    return { chart, statement, cashFlow, outlook, trial, pending, range, grain }
  }, [range, grain])

  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => <LedgerView data={data} onGrain={setGrain} onRange={setRange} />}
    </Resource>
  )
}
