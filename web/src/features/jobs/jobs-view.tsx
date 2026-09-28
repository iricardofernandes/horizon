'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import type { JobItem, SourceReport } from '@/lib/federation'
import { tracedFetch } from '@/lib/telemetry'

type Answer = { jobs: JobItem[]; sources: SourceReport[] }

const REFRESH_MS = 5000

/**
 * The job centre (Phase 66): the person's imports, exports, billing runs and supplier NF-e
 * imports, across modules, with progress. A module that did not answer is named.
 */
export function JobsView() {
  const t = useTranslations('jobs')
  const modules = useTranslations('modules')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await tracedFetch('jobs.federated', '/api/jobs')
      if (!response.ok) throw new Error('unavailable')
      setAnswer((await response.json()) as Answer)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  const silent = (answer?.sources ?? []).filter((source) => source.status !== 'ok')

  return (
    <section>
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      {failed ? <Notice copy={t('failed')} /> : null}
      {silent.length > 0 ? (
        <Notice
          copy={t('silent', {
            modules: [...new Set(silent.map((source) => modules(source.module)))].join(', '),
          })}
        />
      ) : null}
      <section className="panel table-panel table-scroll">
        <PanelHeading copy={t('listCopy')} title={t('listTitle')} />
        <Button onClick={() => void load()} type="button" variant="ghost">
          {t('refresh')}
        </Button>
        {!answer ? (
          <LoadingState />
        ) : answer.jobs.length === 0 ? (
          <Empty copy={t('empty')} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('module')}</th>
                <th>{t('kind')}</th>
                <th>{t('status')}</th>
                <th>{t('progress')}</th>
                <th>{t('started')}</th>
              </tr>
            </thead>
            <tbody>
              {answer.jobs.map((job) => (
                <JobRow job={job} key={`${job.source}:${job.id}`} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  )
}

function JobRow({ job }: { job: JobItem }) {
  const t = useTranslations('jobs')
  const modules = useTranslations('modules')
  const format = useFormatter()
  const [kind, detail] = job.kind.split(':')
  const counted = job.total !== null && job.done !== null
  const progress = counted
    ? t('progressOf', { done: job.done ?? 0, total: job.total ?? 0 })
    : job.done !== null
      ? t('rows', { rows: job.done })
      : ''
  return (
    <tr>
      <td>{modules(job.module)}</td>
      <td>
        <a href={job.href}>{t(`kinds.${kind ?? 'unknown'}`, { detail: detail ?? '' })}</a>
      </td>
      <td>
        <Badge
          label={t.has(`states.${job.status}`) ? t(`states.${job.status}`) : job.status}
          status={job.status}
        />
      </td>
      <td>
        {counted ? (
          <progress aria-label={t('progress')} max={job.total || 1} value={job.done ?? 0}>
            {progress}
          </progress>
        ) : null}{' '}
        {progress}
      </td>
      <td>
        {job.startedAt
          ? format.dateTime(new Date(job.startedAt), { dateStyle: 'short', timeStyle: 'short' })
          : ''}
      </td>
    </tr>
  )
}
