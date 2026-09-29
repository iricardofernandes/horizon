'use client'

import { Tabs } from '@base-ui/react/tabs'
import { useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'
import { AgentDraftBadge, AgentDraftFilter } from '@/components/ui/agent-draft'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ColumnPicker, SavedViewsMenu } from '@/features/views/saved-views-menu'
import { useAgentDrafts, withDrafts } from '@/lib/agent-drafts'
import { filtersOf, queryOf, shownColumns } from '@/lib/saved-views'
import { useStatusLabel } from '@/lib/status'
import { useUrlParam } from '@/lib/url-param'
import { useDate, useMoney } from '@/lib/use-format'
import { ApprovalPolicyDialog } from './approval-policy-dialog'
import { CreateTitleDialog } from './create-title-dialog'
import { TitleDetailDialog } from './title-detail-dialog'
import {
  AGING_BUCKETS,
  type Direction,
  displayStatus,
  inView,
  namespaceOf,
  type TitleRow,
  type TitlesData,
  type TitleView,
  viewsOf,
} from './types'

/** What the session may attempt; Financial still decides every command (ADR 0045). */
export type TitleAbilities = {
  canRecord: boolean
  canReverse: boolean
  canApprove: boolean
  canConfigure: boolean
  /** The signed-in subject, so a requester is not offered their own approval. */
  userId: string | null
}
/** The columns a person may hide; the document, status and actions always show. */
const OPTIONAL_COLUMNS = ['counterparty', 'issuedOn', 'nextDue', 'total', 'outstanding'] as const
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]
const NUMERIC: readonly string[] = ['total', 'outstanding']

export type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

/**
 * Accounts receivable or payable: what is owed, when it falls due and what was settled.
 * Posted titles are never edited away — a correction is a reversal that stays in the
 * timeline (ADR 0042).
 */
export function TitlesView({
  data,
  abilities,
  onChanged,
  setNotice,
}: { data: TitlesData; abilities: TitleAbilities } & MutationProps) {
  const { direction } = data
  const t = useTranslations(namespaceOf(direction))
  const [view, setView] = useState<TitleView>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [columns, setColumns] = useState<string[] | null>(null)
  const shown = shownColumns(OPTIONAL_COLUMNS, columns)
  // A link from another screen names the title to open, or what to search for (Phase 53).
  const openParam = useUrlParam('open')
  const searchParam = useUrlParam('search')
  useEffect(() => {
    if (searchParam) setQuery(searchParam)
  }, [searchParam])
  const linked = useRef(false)
  useEffect(() => {
    if (linked.current || !openParam || !data.titles.some((row) => row.id === openParam)) return
    linked.current = true
    setSelected(openParam)
  }, [openParam, data.titles])
  // Payables an agent drafted (ADR 0066), marked from the agent's own log.
  const drafts = useAgentDrafts(direction === 'payable' ? 'financial' : null, 'payable')
  const normalized = query.trim().toLocaleLowerCase()
  const listed = withDrafts(data.titles, drafts.ids, (row) => [row.id], drafts.only)
  const rows = listed.filter(
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
          <AgentDraftFilter count={drafts.ids.size} onChange={drafts.setOnly} only={drafts.only} />
          {direction === 'payable' && abilities.canConfigure ? (
            <ApprovalPolicyDialog data={data} onChanged={onChanged} setNotice={setNotice} />
          ) : null}
          {abilities.canRecord ? (
            <CreateTitleDialog data={data} onChanged={onChanged} setNotice={setNotice} />
          ) : null}
        </div>
      </header>

      <SummaryCards data={data} />

      <Tabs.Root
        className="catalog-tabs"
        onValueChange={(value) => setView(value as TitleView)}
        value={view}
      >
        <div className="catalog-toolbar receivables-toolbar">
          <Tabs.List aria-label={t('views')} className="ui-tabs-list">
            {viewsOf(direction).map((candidate) => (
              <Tabs.Tab className="ui-tab" key={candidate} value={candidate}>
                {t(`view.${candidate}`)}{' '}
                <span className="tab-count">
                  {data.titles.filter((row) => inView(row, candidate)).length}
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
        <div className="catalog-toolbar saved-views-toolbar">
          <SavedViewsMenu
            columns={columns}
            onApply={(saved) => {
              const filters = filtersOf(saved.query)
              const candidate = filters.view as TitleView | undefined
              setView(candidate && viewsOf(direction).includes(candidate) ? candidate : 'all')
              setQuery(filters.search ?? '')
              setColumns(saved.columns)
            }}
            query={queryOf({ view: view === 'all' ? null : view, search: query.trim() || null })}
            screen={`financial.${direction}s`}
          />
          <ColumnPicker
            all={OPTIONAL_COLUMNS}
            label={t('columns')}
            labelOf={(column) => t(column)}
            onChange={setColumns}
            shown={shown}
          />
        </div>
        <div className="panel table-panel">
          <div className="table-scroll">
            <TitlesTable
              columns={shown}
              direction={direction}
              drafted={(row) => drafts.ids.has(row.id)}
              onOpen={setSelected}
              rows={rows}
            />
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
        <TitleDetailDialog
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

function SummaryCards({ data }: { data: TitlesData }) {
  const { direction } = data
  const t = useTranslations(namespaceOf(direction))
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
        {/* Kept beside what is owed, never added into it: this money is expected, not due. */}
        <article className="customer-summary-card">
          <span>{t('expected')}</span>
          <strong>
            {data.summary.expected.length
              ? data.summary.expected.map((entry) => money(entry.total, entry.currency)).join(' · ')
              : '—'}
          </strong>
        </article>
        {direction === 'payable' ? (
          <article className="customer-summary-card">
            <span>{t('awaitingApproval')}</span>
            <strong>{data.summary.awaitingApproval}</strong>
          </article>
        ) : (
          <article className="customer-summary-card">
            <span>{t('drafts')}</span>
            <strong>{data.summary.drafts}</strong>
          </article>
        )}
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

function TitlesTable({
  direction,
  rows,
  columns,
  onOpen,
  drafted,
}: {
  direction: Direction
  rows: TitleRow[]
  columns: readonly string[]
  onOpen: (id: string) => void
  drafted: (row: TitleRow) => boolean
}) {
  const shown = OPTIONAL_COLUMNS.filter((column) => columns.includes(column))
  const t = useTranslations(namespaceOf(direction))
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const cell: Readonly<Record<OptionalColumn, (row: TitleRow) => string>> = {
    counterparty: (row) => row.partyName ?? t('erasedParty'),
    issuedOn: (row) => date(`${row.issuedOn}T12:00:00`),
    nextDue: (row) => (row.nextDueOn ? date(`${row.nextDueOn}T12:00:00`) : '—'),
    total: (row) => money(row.total, row.currency),
    outstanding: (row) => money(row.outstanding, row.currency),
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{t('document')}</th>
          {shown.map((column) => (
            <th className={NUMERIC.includes(column) ? 'numeric' : undefined} key={column}>
              {t(column)}
            </th>
          ))}
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
                {row.origin.type === 'manual' ? null : (
                  <small className="receivable-origin">{t(`from.${row.origin.type}`)}</small>
                )}
                {drafted(row) ? <AgentDraftBadge /> : null}
              </td>
              {shown.map((column) => (
                <td className={NUMERIC.includes(column) ? 'numeric' : undefined} key={column}>
                  {cell[column](row)}
                </td>
              ))}
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
