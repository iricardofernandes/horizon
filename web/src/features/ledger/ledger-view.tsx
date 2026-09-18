'use client'

import { Tabs } from '@base-ui/react/tabs'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Notice } from '@/components/ui/state'
import { useMoney } from '@/lib/use-format'
import { AccountDrillDialog } from './account-drill-dialog'
import { CashFlowPanel, ChartPanel, IncomeStatementPanel, TrialBalancePanel } from './ledger-panels'
import { GRAINS, type Grain, type LedgerData } from './types'

const REPORTS = ['result', 'cash-flow', 'trial-balance', 'chart'] as const
type Report = (typeof REPORTS)[number]

/**
 * What the books say, and how to get from any figure back to the fact behind it.
 *
 * Every number here is computed from the journal at read time; there is no stored total to
 * drift from the lines it summarises.
 */
export function LedgerView({
  data,
  onRange,
  onGrain,
}: {
  data: LedgerData
  onRange: (range: { from: string; to: string }) => void
  onGrain: (grain: Grain) => void
}) {
  const t = useTranslations('ledger')
  const money = useMoney()
  const [report, setReport] = useState<Report>('result')
  const [drill, setDrill] = useState<string | null>(null)

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p className="catalog-page-copy">{t('copy')}</p>
      </header>

      {data.pending.total ? (
        <Notice copy={t('pendingWarning', { count: data.pending.total })} />
      ) : null}

      <div className="receivables-summary">
        <article className="customer-summary-card">
          <span>{t('result')}</span>
          <strong>{money(data.statement.result, 'BRL')}</strong>
        </article>
        <article className="customer-summary-card">
          <span>{t('cashClosing')}</span>
          <strong>{money(data.cashFlow.closing, 'BRL')}</strong>
        </article>
        <article className="customer-summary-card">
          <span>{t('committed')}</span>
          <strong>{money(data.outlook.committedIn, 'BRL')}</strong>
        </article>
        <article className="customer-summary-card">
          <span>{t('forecast')}</span>
          <strong>{money(data.outlook.forecastIn, 'BRL')}</strong>
        </article>
      </div>

      <div className="catalog-toolbar ledger-toolbar">
        <label className="ledger-field">
          <span className="ledger-field-label">{t('rangeFrom')}</span>
          <input
            className="ui-input"
            onChange={(event) => onRange({ ...data.range, from: event.target.value })}
            type="date"
            value={data.range.from}
          />
        </label>
        <label className="ledger-field">
          <span className="ledger-field-label">{t('rangeTo')}</span>
          <input
            className="ui-input"
            onChange={(event) => onRange({ ...data.range, to: event.target.value })}
            type="date"
            value={data.range.to}
          />
        </label>
        <label className="ledger-field">
          <span className="ledger-field-label">{t('grain')}</span>
          <select
            className="ui-input"
            onChange={(event) => onGrain(event.target.value as Grain)}
            value={data.grain}
          >
            {GRAINS.map((grain) => (
              <option key={grain} value={grain}>
                {t(`grainOption.${grain}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Tabs.Root
        className="catalog-tabs"
        onValueChange={(value) => setReport(value as Report)}
        value={report}
      >
        <Tabs.List aria-label={t('reports')} className="ui-tabs-list">
          {REPORTS.map((candidate) => (
            <Tabs.Tab className="ui-tab" key={candidate} value={candidate}>
              {t(`report.${candidate}`)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {report === 'result' ? <IncomeStatementPanel statement={data.statement} /> : null}
        {report === 'cash-flow' ? (
          <CashFlowPanel cashFlow={data.cashFlow} outlook={data.outlook} />
        ) : null}
        {report === 'trial-balance' ? (
          <TrialBalancePanel onOpen={setDrill} trial={data.trial} />
        ) : null}
        {report === 'chart' ? <ChartPanel chart={data.chart} onOpen={setDrill} /> : null}
      </Tabs.Root>

      {drill ? (
        <AccountDrillDialog accountId={drill} onClose={() => setDrill(null)} range={data.range} />
      ) : null}
    </section>
  )
}
