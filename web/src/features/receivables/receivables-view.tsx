'use client'

import { Tabs } from '@base-ui/react/tabs'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney } from '@/lib/use-format'
import { CreateReceivableDialog } from './create-receivable-dialog'
import { ReceivableDetailDialog } from './receivable-detail-dialog'
import {
  AGING_BUCKETS,
  displayStatus,
  inView,
  RECEIVABLE_VIEWS,
  type ReceivableRow,
  type ReceivablesData,
  type ReceivableView,
} from './types'

export type ReceivableAbilities = { canRecord: boolean; canReverse: boolean }
export type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

/**
 * Accounts receivable: what customers owe, when it falls due and what was collected. Posted
 * titles are never edited away — a correction is a reversal that stays in the timeline
 * (ADR 0042).
 */
export function ReceivablesView({
  data,
  abilities,
  onChanged,
  setNotice,
}: { data: ReceivablesData; abilities: ReceivableAbilities } & MutationProps) {
  const t = useTranslations('receivables')
  const [view, setView] = useState<ReceivableView>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const rows = data.receivables.filter(
    (row) =>
      inView(row, view) &&
      (!normalized ||
        row.documentNumber.toLocaleLowerCase().includes(normalized) ||
        (row.partyName ?? '').toLocaleLowerCase().includes(normalized)),
  )

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('title')}</h1>
          <p className="catalog-page-copy">{t('copy')}</p>
        </div>
        <div className="page-actions">
          {abilities.canRecord ? (
            <CreateReceivableDialog data={data} onChanged={onChanged} setNotice={setNotice} />
          ) : null}
        </div>
      </header>

      <SummaryCards data={data} />

      <Tabs.Root
        className="catalog-tabs"
        onValueChange={(value) => setView(value as ReceivableView)}
        value={view}
      >
        <div className="catalog-toolbar receivables-toolbar">
          <Tabs.List aria-label={t('views')} className="ui-tabs-list">
            {RECEIVABLE_VIEWS.map((candidate) => (
              <Tabs.Tab className="ui-tab" key={candidate} value={candidate}>
                {t(`view.${candidate}`)}{' '}
                <span className="tab-count">
                  {data.receivables.filter((row) => inView(row, candidate)).length}
                </span>
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <input
            aria-label={t('search')}
            className="ui-input receivables-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
            type="search"
            value={query}
          />
        </div>
        <div className="panel table-panel">
          <div className="table-scroll">
            <ReceivablesTable onOpen={setSelected} rows={rows} />
          </div>
          {!rows.length ? (
            <div className="catalog-empty">
              <strong>{t('emptyTitle')}</strong>
              <p>{t('emptyCopy')}</p>
            </div>
          ) : null}
        </div>
      </Tabs.Root>

      {selected ? (
        <ReceivableDetailDialog
          abilities={abilities}
          data={data}
          id={selected}
          onChanged={onChanged}
          onClose={() => setSelected(null)}
          setNotice={setNotice}
        />
      ) : null}
    </section>
  )
}

function SummaryCards({ data }: { data: ReceivablesData }) {
  const t = useTranslations('receivables')
  const money = useMoney()
  const totals = data.summary.currencies
  const sum = (pick: (entry: (typeof totals)[number]) => string) =>
    totals.length ? totals.map((entry) => money(pick(entry), entry.currency)).join(' · ') : '—'
  return (
    <>
      <div className="receivables-summary">
        <article className="customer-summary-card">
          <span>{t('outstanding')}</span>
          <strong>{sum((entry) => entry.outstanding)}</strong>
        </article>
        <article className="customer-summary-card receivables-overdue-card">
          <span>{t('overdue')}</span>
          <strong>{sum((entry) => entry.overdue)}</strong>
        </article>
        <article className="customer-summary-card">
          <span>{t('dueWithin7Days')}</span>
          <strong>{sum((entry) => entry.dueWithin7Days)}</strong>
        </article>
        <article className="customer-summary-card">
          <span>{t('drafts')}</span>
          <strong>{data.summary.drafts}</strong>
        </article>
      </div>
      {totals.map((entry) => (
        <section
          aria-label={t('agingOf', { currency: entry.currency })}
          className="panel receivables-aging"
          key={entry.currency}
        >
          <h2>{t('aging')}</h2>
          <dl>
            {AGING_BUCKETS.map((bucket) => (
              <div key={bucket}>
                <dt>{t(`bucket.${bucket}`)}</dt>
                <dd>{money(entry.aging[bucket], entry.currency)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  )
}

function ReceivablesTable({
  rows,
  onOpen,
}: {
  rows: ReceivableRow[]
  onOpen: (id: string) => void
}) {
  const t = useTranslations('receivables')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  return (
    <table>
      <thead>
        <tr>
          <th>{t('document')}</th>
          <th>{t('customer')}</th>
          <th>{t('issuedOn')}</th>
          <th>{t('nextDue')}</th>
          <th className="numeric">{t('total')}</th>
          <th className="numeric">{t('outstanding')}</th>
          <th>{t('status')}</th>
          <th aria-label={common('actions')} />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const status = displayStatus(row)
          return (
            <tr key={row.id}>
              <td>
                <strong>{row.documentNumber}</strong>
                {row.origin.type === 'sales-order' ? (
                  <small className="receivable-origin">{t('fromSalesOrder')}</small>
                ) : null}
              </td>
              <td>{row.partyName ?? t('erasedParty')}</td>
              <td>{date(`${row.issuedOn}T12:00:00`)}</td>
              <td>{row.nextDueOn ? date(`${row.nextDueOn}T12:00:00`) : '—'}</td>
              <td className="numeric">{money(row.total, row.currency)}</td>
              <td className="numeric">{money(row.outstanding, row.currency)}</td>
              <td>
                <Badge label={statusLabel(status)} status={status} />
              </td>
              <td>
                <Button
                  aria-label={t('openLabel', { document: row.documentNumber })}
                  onClick={() => onOpen(row.id)}
                  type="button"
                  variant="secondary"
                >
                  {t('details')}
                </Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
