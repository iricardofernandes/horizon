'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { Empty, LoadingState } from '@/components/ui/state'
import {
  type ImportingModule,
  type ImportJob,
  type ImportKind,
  importingModules,
  percentDone,
} from '@/lib/import-file'
import { importApi } from './import-api'
import { ImportWizard } from './import-wizard'

/**
 * Bulk imports into any module that implements the job contract (Phase 64): one wizard,
 * driven by the kinds and fields each module declares, and the module's recent jobs.
 */
export function ImportsView() {
  const t = useTranslations('imports')
  const modules = useTranslations('modules')
  const format = useFormatter()
  const session = useSession()
  const available = useMemo(() => importingModules(session?.roles ?? []), [session?.roles])
  const [module, setModule] = useState<ImportingModule | null>(available[0] ?? null)
  const [kinds, setKinds] = useState<ImportKind[] | null>(null)
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [job, setJob] = useState<ImportJob | null>(null)
  const [error, setError] = useState('')
  const api = useMemo(() => (module ? importApi(module, t('failed')) : null), [module, t])

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const [declared, recent] = await Promise.all([api.kinds(), api.list()])
      setKinds(declared)
      setJobs(recent)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('failed'))
    }
  }, [api, t])

  useEffect(() => {
    setKinds(null)
    setJob(null)
    void refresh()
  }, [refresh])

  const onJob = useCallback(
    (next: ImportJob | null) => {
      setJob(next)
      void refresh()
    },
    [refresh],
  )

  return (
    <section>
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      {available.length === 0 ? (
        <Empty copy={t('noModule')} />
      ) : (
        <>
          <div className="crm-toolbar">
            <SelectField
              label={t('module')}
              name="module"
              onValueChange={(value) => setModule((value as ImportingModule | null) ?? null)}
              options={available.map((value) => ({ label: modules(value), value }))}
              value={module}
            />
          </div>
          {error ? <p role="alert">{error}</p> : null}
          {!api || kinds === null ? (
            <LoadingState />
          ) : (
            <ImportWizard api={api} job={job} kinds={kinds} onJob={onJob} />
          )}
          <section className="panel table-panel table-scroll">
            <PanelHeading copy={t('recent.copy')} title={t('recent.title')} />
            {jobs.length === 0 ? (
              <Empty copy={t('recent.empty')} />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t('recent.file')}</th>
                    <th>{t('kind')}</th>
                    <th>{t('recent.status')}</th>
                    <th>{t('recent.progress')}</th>
                    <th>{t('recent.created')}</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          className="crm-link-button"
                          onClick={() => setJob(row)}
                          type="button"
                        >
                          {row.fileName}
                        </button>
                      </td>
                      <td>{t(`kinds.${row.kind}`)}</td>
                      <td>
                        <Badge label={t(`status.${row.status}`)} status={row.status} />
                      </td>
                      <td>
                        {t('recent.summary', {
                          percent: percentDone(row.progress),
                          written: row.progress.written,
                          failed: row.progress.failed,
                          total: row.progress.total,
                        })}
                      </td>
                      <td>
                        {format.dateTime(new Date(row.createdAt), {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </section>
  )
}
