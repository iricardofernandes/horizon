'use client'

import { DownloadSimple } from '@phosphor-icons/react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import type { AuditEntry, AuditSourceReport } from '@/lib/audit'
import { tracedFetch } from '@/lib/telemetry'

type Answer = {
  entries: AuditEntry[]
  sources: AuditSourceReport[]
  readable: string[]
  actors: Record<string, string>
}

type Filters = {
  module: string
  actor: string
  action: string
  subjectType: string
  subjectId: string
  from: string
  to: string
}

const ALL = 'all'

const NO_FILTERS: Filters = {
  module: ALL,
  actor: '',
  action: '',
  subjectType: '',
  subjectId: '',
  from: '',
  to: '',
}

/** The query a set of filters asks for; dates bound whole days. */
function queryOf(filters: Filters): URLSearchParams {
  const query = new URLSearchParams()
  if (filters.module !== ALL) query.set('module', filters.module)
  for (const key of ['actor', 'action', 'subjectType', 'subjectId'] as const)
    if (filters[key].trim()) query.set(key, filters[key].trim())
  if (filters.from) query.set('from', `${filters.from}T00:00:00.000Z`)
  if (filters.to) query.set('to', `${filters.to}T23:59:59.999Z`)
  return query
}

/** Where every module that answered stands, merged across pages already read. */
function mergeReports(
  earlier: readonly AuditSourceReport[],
  later: readonly AuditSourceReport[],
): AuditSourceReport[] {
  const merged = new Map(earlier.map((report) => [report.module, report]))
  for (const report of later) {
    const before = merged.get(report.module)
    const broken = [...(before?.chain?.broken ?? []), ...(report.chain?.broken ?? [])]
    merged.set(report.module, {
      ...report,
      chain: report.chain
        ? {
            status: broken.length ? 'broken' : 'intact',
            checked: (before?.chain?.checked ?? 0) + report.chain.checked,
            broken,
          }
        : (before?.chain ?? null),
    })
  }
  return [...merged.values()]
}

/**
 * The audit screen (Phase 68): every module log the person administers, searched at once
 * and merged, with each module's hash-chain verdict. A module that did not answer is named;
 * a broken chain is shown on the module and on each row that fails.
 */
export function AuditView() {
  const t = useTranslations('audit')
  const modules = useTranslations('modules')
  const locale = useLocale() === 'en' ? 'en' : 'pt-BR'
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [applied, setApplied] = useState<Filters>(NO_FILTERS)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (chosen: Filters, previous: Answer | null) => {
    setLoading(true)
    const query = queryOf(chosen)
    for (const report of previous?.sources ?? [])
      if (report.nextCursor) query.set(`cursor.${report.module}`, report.nextCursor)
    try {
      const response = await tracedFetch('audit.federated', `/api/audit?${query}`)
      if (!response.ok) throw new Error('unavailable')
      const next = (await response.json()) as Answer
      setAnswer(
        previous
          ? {
              ...next,
              entries: [...previous.entries, ...next.entries],
              sources: mergeReports(previous.sources, next.sources),
            }
          : next,
      )
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(NO_FILTERS, null)
  }, [load])

  const search = (event: FormEvent) => {
    event.preventDefault()
    setApplied(filters)
    void load(filters, null)
  }

  const exportQuery = queryOf(applied)
  exportQuery.set('locale', locale)
  const silent = (answer?.sources ?? []).filter((source) => source.status !== 'ok')
  const more = (answer?.sources ?? []).some((source) => source.nextCursor)
  const set = (key: keyof Filters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }))

  return (
    <section className="audit-screen">
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      {failed ? <Notice copy={t('failed')} /> : null}
      {answer && answer.readable.length === 0 ? <Notice copy={t('noneReadable')} /> : null}
      {silent.length > 0 ? (
        <Notice
          copy={t('silent', {
            modules: silent.map((source) => modules(source.module)).join(', '),
          })}
        />
      ) : null}
      <form className="panel" onSubmit={search}>
        <PanelHeading copy={t('filtersCopy')} title={t('filtersTitle')} />
        <div className="form-grid four-columns">
          <SelectField
            label={t('module')}
            name="module"
            onValueChange={(value) => set('module')(value ?? ALL)}
            options={[
              { label: t('allModules'), value: ALL },
              ...(answer?.readable ?? []).map((module) => ({
                label: modules(module),
                value: module,
              })),
            ]}
            value={filters.module}
          />
          <TextField
            label={t('actor')}
            name="actor"
            onChange={(event) => set('actor')(event.target.value)}
            value={filters.actor}
          />
          <TextField
            label={t('action')}
            name="action"
            onChange={(event) => set('action')(event.target.value)}
            value={filters.action}
          />
          <TextField
            label={t('subjectType')}
            name="subjectType"
            onChange={(event) => set('subjectType')(event.target.value)}
            value={filters.subjectType}
          />
          <TextField
            label={t('subjectId')}
            name="subjectId"
            onChange={(event) => set('subjectId')(event.target.value)}
            value={filters.subjectId}
          />
          <TextField
            label={t('from')}
            name="from"
            onChange={(event) => set('from')(event.target.value)}
            type="date"
            value={filters.from}
          />
          <TextField
            label={t('to')}
            name="to"
            onChange={(event) => set('to')(event.target.value)}
            type="date"
            value={filters.to}
          />
        </div>
        <div className="dialog-actions audit-actions">
          <Button disabled={loading} type="submit" variant="primary">
            {t('search')}
          </Button>
          <a
            className="ui-button ui-button-secondary"
            download
            href={`/api/audit/export?${exportQuery}`}
            title={t('exportHint')}
          >
            <DownloadSimple aria-hidden size={16} />
            {t('export')}
          </a>
        </div>
      </form>
      {answer ? <ChainSummary reports={answer.sources} /> : null}
      <section className="panel table-panel table-scroll">
        <PanelHeading copy={t('listCopy')} title={t('listTitle')} />
        {!answer ? (
          <LoadingState />
        ) : answer.entries.length === 0 ? (
          <Empty copy={t('empty')} />
        ) : (
          <AuditTable actors={answer.actors} entries={answer.entries} reports={answer.sources} />
        )}
        {more ? (
          <Button
            disabled={loading}
            onClick={() => void load(applied, answer)}
            type="button"
            variant="ghost"
          >
            {t('more')}
          </Button>
        ) : null}
      </section>
    </section>
  )
}

function ChainSummary({ reports }: { reports: readonly AuditSourceReport[] }) {
  const t = useTranslations('audit')
  const modules = useTranslations('modules')
  const answered = reports.filter((report) => report.chain)
  if (answered.length === 0) return null
  return (
    <section className="panel" aria-label={t('chainTitle')}>
      <PanelHeading copy={t('chainCopy')} title={t('chainTitle')} />
      <ul className="chain-summary">
        {answered.map((report) => (
          <li key={report.module}>
            <strong>{modules(report.module)}</strong>{' '}
            {report.chain?.status === 'broken' ? (
              <Badge
                label={t('broken', { rows: report.chain.broken.join(', ') })}
                status="rejected"
              />
            ) : (
              <Badge label={t('intact', { rows: report.chain?.checked ?? 0 })} status="active" />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function AuditTable({
  entries,
  reports,
  actors,
}: {
  entries: readonly AuditEntry[]
  reports: readonly AuditSourceReport[]
  actors: Readonly<Record<string, string>>
}) {
  const t = useTranslations('audit')
  const modules = useTranslations('modules')
  const format = useFormatter()
  const broken = new Set(
    reports.flatMap((report) =>
      (report.chain?.broken ?? []).map((sequence) => `${report.module}:${sequence}`),
    ),
  )
  return (
    <table>
      <thead>
        <tr>
          <th>{t('when')}</th>
          <th>{t('module')}</th>
          <th>{t('actor')}</th>
          <th>{t('action')}</th>
          <th>{t('record')}</th>
          <th>{t('details')}</th>
          <th>{t('chain')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const failing = broken.has(`${entry.module}:${entry.sequence}`)
          return (
            <tr
              className={failing ? 'audit-broken' : undefined}
              key={`${entry.module}:${entry.sequence}`}
            >
              <td>
                {format.dateTime(new Date(entry.occurredAt), {
                  dateStyle: 'short',
                  timeStyle: 'medium',
                })}
              </td>
              <td>{modules(entry.module)}</td>
              <td title={entry.actor}>{actors[entry.actor] ?? entry.actor}</td>
              <td>
                <code>{entry.action}</code>
              </td>
              <td title={entry.subjectId}>
                {entry.subjectType} · {entry.subjectId.slice(0, 8)}
              </td>
              <td className="audit-details">
                {entry.sealed ? t('sealed') : detailsOf(entry.details, actors, t('onBehalfOf'))}
              </td>
              <td>
                {failing ? (
                  <Badge label={t('rowBroken', { sequence: entry.sequence })} status="rejected" />
                ) : (
                  <span className="muted">#{entry.sequence}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** The details, compactly; who a delegate acted for is spelled out. */
function detailsOf(
  details: Record<string, unknown> | null,
  actors: Readonly<Record<string, string>>,
  onBehalfOf: string,
): string {
  if (!details) return ''
  const { onBehalfOf: delegator, delegationId: _delegation, ...rest } = details
  const text = Object.keys(rest).length ? JSON.stringify(rest) : ''
  if (typeof delegator !== 'string') return text
  return `${onBehalfOf} ${actors[delegator] ?? delegator}${text ? ` · ${text}` : ''}`
}
