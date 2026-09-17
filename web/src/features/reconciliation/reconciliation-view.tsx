'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { SelectField } from '@/components/ui/select-field'
import { LoadingState, Notice } from '@/components/ui/state'
import { localToday } from '@/features/titles/types'
import type { TreasuryAccount } from '@/features/treasury/types'
import { readJson } from '@/lib/api'
import { TREASURY_API } from './commands'
import { ReconciliationPanes } from './reconciliation-panes'
import {
  HistoryPanel,
  ImportDialog,
  PeriodControls,
  SuggestionsPanel,
  SummaryCards,
} from './reconciliation-parts'
import type { Metrics, ReconciliationAbilities, Workspace } from './types'

function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`
}

/**
 * Where the bank's record meets the books'. Imported statements never change; a person
 * matches, ignores or adjusts, and every decision can be undone (ADR 0046).
 */
export function ReconciliationView({
  accounts,
  abilities,
  setNotice,
}: {
  accounts: TreasuryAccount[]
  abilities: ReconciliationAbilities
  setNotice: (value: string) => void
}) {
  const t = useTranslations('reconciliation')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [from, setFrom] = useState(firstOfMonth(localToday()))
  const [to, setTo] = useState(localToday())
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!accountId) return
    try {
      const [loaded, measured] = await Promise.all([
        readJson<Workspace>(
          'treasury.reconciliation',
          `${TREASURY_API}/accounts/${accountId}/reconciliation?from=${from}&to=${to}`,
        ),
        readJson<Metrics>(
          'treasury.reconciliation.metrics',
          `${TREASURY_API}/accounts/${accountId}/reconciliation/metrics`,
        ),
      ])
      setWorkspace(loaded)
      setMetrics(measured)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [accountId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  const done = async (notice: string) => {
    setNotice(notice)
    await load()
  }

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('title')}</h1>
          <p className="catalog-page-copy">{t('copy')}</p>
        </div>
        <div className="page-actions">
          {abilities.canRecord && accountId ? (
            <ImportDialog accountId={accountId} onDone={done} />
          ) : null}
        </div>
      </header>
      {!accounts.length ? (
        <Notice copy={t('noAccounts')} />
      ) : (
        <div className="panel reconciliation-filters">
          <SelectField
            label={t('account')}
            name="accountId"
            onValueChange={(value) => setAccountId(value ?? accountId)}
            options={accounts.map((account) => ({ value: account.id, label: account.name }))}
            value={accountId}
          />
          <label className="ui-field">
            <span className="ui-field-label">{t('rangeFrom')}</span>
            <input
              className="ui-input"
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              type="date"
              value={from}
            />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">{t('rangeTo')}</span>
            <input
              className="ui-input"
              min={from}
              onChange={(event) => setTo(event.target.value)}
              type="date"
              value={to}
            />
          </label>
          {workspace && abilities.canClose ? (
            <PeriodControls accountId={accountId} onDone={done} workspace={workspace} />
          ) : null}
        </div>
      )}
      {failed ? <Notice copy={t('unavailable')} /> : null}
      {!failed && accounts.length && !workspace ? <LoadingState /> : null}
      {workspace ? (
        <>
          <SummaryCards metrics={metrics} workspace={workspace} />
          <SuggestionsPanel
            abilities={abilities}
            accountId={accountId}
            onDone={done}
            workspace={workspace}
          />
          <ReconciliationPanes
            abilities={abilities}
            accountId={accountId}
            key={`${accountId}:${from}:${to}`}
            onDone={done}
            workspace={workspace}
          />
          <HistoryPanel abilities={abilities} onDone={done} workspace={workspace} />
        </>
      ) : null}
    </section>
  )
}
