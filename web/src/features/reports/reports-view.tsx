'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useCallback, useState } from 'react'
import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { apiError, readJson, readPage } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import {
  cutoffOf,
  type Dashboard,
  REPORTING_API,
  type ReconciliationRun,
  type ReportAnswer,
  type ReportCatalogEntry,
  reportingAbilitiesOf,
  reportQuery,
  tablesOf,
} from '@/lib/reports'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'
import { ExportPanel } from './export-panel'
import { FigureTables, SourceStates } from './figure-tables'

type Question = { report: string; cutoff: string | null; currency: string }

/**
 * Cross-module reports (ADR 0058, screens since Phase 70): the dashboard at the latest cutoff,
 * then one report at a cutoff the person chooses, with where each source stands, how it
 * reconciled against the owners' own reports, and its files. Reporting computes every figure.
 */
export function ReportsView({
  catalog,
  dashboard,
}: {
  catalog: ReportCatalogEntry[]
  dashboard: Dashboard
}) {
  const t = useTranslations('reports')
  const session = useSession()
  const abilities = reportingAbilitiesOf(session?.roles ?? [])
  const [question, setQuestion] = useState<Question>({
    report: catalog[0]?.name ?? '',
    cutoff: null,
    currency: '',
  })
  const [draft, setDraft] = useState({ report: question.report, cutoff: '', currency: '' })

  const ask = (event: FormEvent) => {
    event.preventDefault()
    setQuestion({ report: draft.report, cutoff: cutoffOf(draft.cutoff), currency: draft.currency })
  }

  return (
    <section className="reports-screen">
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      <DashboardCards dashboard={dashboard} />
      <form className="panel" onSubmit={ask}>
        <PanelHeading copy={t('askCopy')} title={t('askTitle')} />
        <div className="form-grid four-columns">
          <SelectField
            label={t('report')}
            name="report"
            onValueChange={(value) => setDraft((current) => ({ ...current, report: value ?? '' }))}
            options={catalog.map((entry) => ({
              label: t(`names.${entry.name}`),
              value: entry.name,
            }))}
            value={draft.report}
          />
          <TextField
            description={t('cutoffHint')}
            label={t('cutoff')}
            name="cutoff"
            onChange={(event) =>
              setDraft((current) => ({ ...current, cutoff: event.target.value }))
            }
            type="datetime-local"
            value={draft.cutoff}
          />
          <TextField
            label={t('currency')}
            maxLength={3}
            name="currency"
            onChange={(event) =>
              setDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))
            }
            value={draft.currency}
          />
        </div>
        <div className="dialog-actions">
          <Button type="submit" variant="primary">
            {t('show')}
          </Button>
        </div>
      </form>
      {question.report ? (
        <ReportDetail abilities={abilities} key={JSON.stringify(question)} question={question} />
      ) : null}
    </section>
  )
}

function DashboardCards({ dashboard }: { dashboard: Dashboard }) {
  const t = useTranslations('reports')
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  return (
    <section className="panel">
      <PanelHeading
        copy={t('dashboardCopy', { cutoff: dateTime(dashboard.cutoff) })}
        title={t('dashboardTitle')}
      />
      <div className="report-cards">
        {Object.entries(dashboard.reports).map(([name, entry]) => (
          <article className="report-card" key={name}>
            <header>
              <h3>{t(`names.${name}`)}</h3>
              <Badge
                label={entry.settled ? t('settled') : statusLabel('pending')}
                status={entry.settled ? 'settled' : 'pending'}
              />
            </header>
            <FigureTables tables={tablesOf(entry.headline)} />
          </article>
        ))}
      </div>
    </section>
  )
}

function ReportDetail({
  question,
  abilities,
}: {
  question: Question
  abilities: ReturnType<typeof reportingAbilitiesOf>
}) {
  const t = useTranslations('reports')
  const query = reportQuery(question.cutoff, { currency: question.currency })
  const load = useCallback(async () => {
    const base = `${REPORTING_API}/reports/${question.report}`
    const [answer, runs] = await Promise.all([
      readJson<ReportAnswer>('reporting.report', `${base}?${query}`),
      readPage<ReconciliationRun>('reporting.reconciliations', `${base}/reconciliations?limit=10`),
    ])
    return { answer, runs }
  }, [question.report, query])
  const state = useLoader(load)

  return (
    <Resource state={state}>
      {({ answer, runs }) => (
        <>
          <section className="panel">
            <PanelHeading
              copy={answer.settled ? t('settledCopy') : t('unsettledCopy')}
              title={t(`names.${answer.report}`)}
            />
            <SourceStates sources={answer.sources} />
            <FigureTables tables={tablesOf(answer.data)} />
          </section>
          <ReconciliationPanel
            canReconcile={abilities.reconcile}
            cutoff={answer.cutoff}
            onDone={state.reload}
            report={answer.report}
            runs={runs}
          />
          {abilities.export ? (
            <ExportPanel
              canSchedule={abilities.schedule}
              cutoff={answer.cutoff}
              currency={question.currency}
              report={answer.report}
            />
          ) : null}
        </>
      )}
    </Resource>
  )
}

function ReconciliationPanel({
  report,
  cutoff,
  runs,
  canReconcile,
  onDone,
}: {
  report: string
  cutoff: string
  runs: readonly ReconciliationRun[]
  canReconcile: boolean
  onDone: () => Promise<void>
}) {
  const t = useTranslations('reports')
  const setNotice = useNotice()
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function reconcile() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'reporting.reconcile',
      `${REPORTING_API}/reports/${report}/reconciliations`,
      { method: 'POST', headers: idempotentJsonHeaders(), body: JSON.stringify({ cutoff }) },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('reconcileFailed')))
      return
    }
    setNotice(t('reconciled'))
    await onDone()
  }

  return (
    <section className="panel table-panel">
      <PanelHeading copy={t('reconcileCopy')} title={t('reconcileTitle')} />
      {error ? <Notice copy={error} /> : null}
      {canReconcile ? (
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => void reconcile()} type="button" variant="primary">
            {t('reconcile')}
          </Button>
        </div>
      ) : null}
      {runs.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('cutoff')}</th>
                <th>{t('outcome')}</th>
                <th>{t('checks')}</th>
                <th>{t('startedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId}>
                  <td>{dateTime(run.cutoff)}</td>
                  <td>
                    <Badge label={t(`outcomes.${run.outcome}`)} status={run.outcome} />
                  </td>
                  <td>
                    {run.checks
                      .map((check) => `${check.check}: ${statusLabel(check.outcome)}`)
                      .join(' · ')}
                  </td>
                  <td>{run.startedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="catalog-page-copy">{t('noRuns')}</p>
      )}
    </section>
  )
}
