'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { Notice } from '@/components/ui/state'
import { apiError, readPage } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import {
  CADENCES,
  downloadable,
  downloadPathOf,
  EXPORT_FORMATS,
  type ExportJob,
  type ExportSchedule,
  REPORTING_API,
} from '@/lib/reports'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'

type Files = { jobs: ExportJob[]; schedules: ExportSchedule[] }

/**
 * A report as a file (ADR 0059): asked now at the cutoff on screen, or on a schedule. Each
 * file carries its digest, and its link is signed for 15 minutes when it is opened.
 */
export function ExportPanel({
  report,
  cutoff,
  currency,
  canSchedule,
}: {
  report: string
  cutoff: string
  currency: string
  canSchedule: boolean
}) {
  const t = useTranslations('reports')
  const locale = useLocale() === 'en' ? 'en' : 'pt-BR'
  const setNotice = useNotice()
  const [format, setFormat] = useState<string>('xlsx')
  const [cadence, setCadence] = useState<string>('daily')
  const [error, setError] = useState('')
  const load = useCallback(async (): Promise<Files> => {
    const [jobs, schedules] = await Promise.all([
      readPage<ExportJob>('reporting.exports', `${REPORTING_API}/exports?limit=50`),
      canSchedule
        ? readPage<ExportSchedule>('reporting.schedules', `${REPORTING_API}/export-schedules`)
        : Promise.resolve([]),
    ])
    return {
      jobs: jobs.filter((job) => job.report === report).slice(0, 10),
      schedules: schedules.filter((schedule) => schedule.report === report),
    }
  }, [report, canSchedule])
  const state = useLoader(load)
  const filter = currency ? { currency } : {}

  async function send(name: string, path: string, body: unknown, success: string) {
    setError('')
    const response = await tracedFetch(name, `${REPORTING_API}${path}`, {
      method: 'POST',
      headers: idempotentJsonHeaders(),
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      setError(await apiError(response, t('exportFailed')))
      return
    }
    setNotice(success)
    await state.reload()
  }

  async function unschedule(scheduleId: string) {
    const response = await tracedFetch(
      'reporting.schedule.delete',
      `${REPORTING_API}/export-schedules/${scheduleId}`,
      { method: 'DELETE', headers: jsonHeaders() },
    )
    if (!response.ok) {
      setError(await apiError(response, t('exportFailed')))
      return
    }
    setNotice(t('unscheduled'))
    await state.reload()
  }

  return (
    <section className="panel table-panel">
      <PanelHeading copy={t('exportCopy')} title={t('exportTitle')} />
      {error ? <Notice copy={error} /> : null}
      <div className="form-grid four-columns">
        <SelectField
          label={t('format')}
          name="format"
          onValueChange={(value) => setFormat(value ?? 'xlsx')}
          options={EXPORT_FORMATS.map((value) => ({ label: value.toUpperCase(), value }))}
          value={format}
        />
        {canSchedule ? (
          <SelectField
            label={t('cadence')}
            name="cadence"
            onValueChange={(value) => setCadence(value ?? 'daily')}
            options={CADENCES.map((value) => ({ label: t(`cadences.${value}`), value }))}
            value={cadence}
          />
        ) : null}
      </div>
      <div className="dialog-actions">
        <Button
          onClick={() =>
            void send(
              'reporting.export',
              '/exports',
              { report, cutoff, format, locale, filter },
              t('exportRequested'),
            )
          }
          type="button"
          variant="primary"
        >
          {t('exportNow')}
        </Button>
        {canSchedule ? (
          <Button
            onClick={() =>
              void send(
                'reporting.schedule',
                '/export-schedules',
                {
                  report,
                  format,
                  locale,
                  filter,
                  cadence,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
                t('scheduled'),
              )
            }
            type="button"
            variant="secondary"
          >
            {t('schedule')}
          </Button>
        ) : null}
      </div>
      {state.data ? (
        <FileList data={state.data} onUnschedule={unschedule} onReload={state.reload} />
      ) : null}
    </section>
  )
}

function FileList({
  data,
  onUnschedule,
  onReload,
}: {
  data: Files
  onUnschedule: (scheduleId: string) => Promise<void>
  onReload: () => Promise<void>
}) {
  const t = useTranslations('reports')
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  const [error, setError] = useState('')

  async function open(job: ExportJob) {
    setError('')
    const response = await tracedFetch(
      'reporting.export.link',
      `${REPORTING_API}/exports/${job.jobId}/link`,
    )
    const body = response.ok ? ((await response.json()) as { url?: string }) : null
    const path = body?.url ? downloadPathOf(body.url) : null
    if (!path) {
      setError(t('linkFailed'))
      return
    }
    window.location.assign(path)
  }

  return (
    <>
      {error ? <Notice copy={error} /> : null}
      <div className="dialog-actions">
        <Button onClick={() => void onReload()} type="button" variant="ghost">
          {t('refresh')}
        </Button>
      </div>
      {data.jobs.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('requestedAt')}</th>
                <th>{t('cutoff')}</th>
                <th>{t('format')}</th>
                <th>{t('status')}</th>
                <th>{t('digest')}</th>
                <th aria-label={t('download')} />
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => (
                <tr key={job.jobId}>
                  <td>{dateTime(job.requestedAt)}</td>
                  <td>{dateTime(job.cutoff)}</td>
                  <td>{job.format.toUpperCase()}</td>
                  <td>
                    <Badge label={statusLabel(job.status)} status={job.status} />
                  </td>
                  <td>
                    <code title={job.sha256 ?? ''}>{job.sha256?.slice(0, 12) ?? '—'}</code>
                  </td>
                  <td>
                    {downloadable(job, new Date()) ? (
                      <Button onClick={() => void open(job)} type="button" variant="secondary">
                        {t('download')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="catalog-page-copy">{t('noExports')}</p>
      )}
      {data.schedules.length ? (
        <ul className="report-schedules">
          {data.schedules.map((schedule) => (
            <li key={schedule.scheduleId}>
              {t('scheduleLine', {
                cadence: t(`cadences.${schedule.cadence}`),
                format: schedule.format.toUpperCase(),
                next: schedule.nextDueAt ? dateTime(schedule.nextDueAt) : '—',
              })}
              <Button
                onClick={() => void onUnschedule(schedule.scheduleId)}
                type="button"
                variant="ghost"
              >
                {t('unschedule')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
