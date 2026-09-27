'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useCallback, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Resource } from '@/components/ui/resource'
import { SelectField } from '@/components/ui/select-field'
import { Empty } from '@/components/ui/state'
import { useDateTime } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'
import { type CrmDirectory, loadDirectory, readCrm, send, useCrmAbilities } from './crm-data'
import { accountName, type Task } from './types'

const HORIZONS = { day: 1, week: 7, month: 30 } as const
type Horizon = keyof typeof HORIZONS

/** The caller's open tasks due by the horizon, overdue first (Phase 57). */
export function AgendaPage() {
  const t = useTranslations('crm')
  const [horizon, setHorizon] = useState<Horizon>('week')
  const load = useCallback(async () => {
    const until = new Date(Date.now() + HORIZONS[horizon] * 86_400_000).toISOString()
    const [directory, agenda] = await Promise.all([
      loadDirectory(),
      readCrm<{ data: Task[] }>(
        'crm.agenda',
        `/agenda?until=${encodeURIComponent(until)}&limit=200`,
      ),
    ])
    return { directory, tasks: agenda.data }
  }, [horizon])
  const state = useLoader(load)
  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('agenda.title')}</h1>
        <p className="catalog-page-copy">{t('agenda.copy')}</p>
      </header>
      <div className="crm-toolbar">
        <SelectField
          label={t('agenda.horizon')}
          name="horizon"
          onValueChange={(value) => setHorizon((value as Horizon | null) ?? 'week')}
          options={(Object.keys(HORIZONS) as Horizon[]).map((value) => ({
            label: t(`agenda.horizons.${value}`),
            value,
          }))}
          value={horizon}
        />
      </div>
      <Resource state={state}>
        {(data) => (
          <AgendaList directory={data.directory} onChanged={state.reload} tasks={data.tasks} />
        )}
      </Resource>
    </section>
  )
}

function subjectLink(task: Task): string {
  if (task.subject.type === 'opportunity') return `/app/crm/pipeline?open=${task.subject.id}`
  return `/app/crm/accounts?open=${task.accountId}`
}

function AgendaList({
  tasks,
  directory,
  onChanged,
}: {
  tasks: readonly Task[]
  directory: CrmDirectory
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const when = useDateTime()
  const setNotice = useNotice()
  const abilities = useCrmAbilities()
  const [error, setError] = useState('')
  const accounts = new Map(directory.accounts.map((row) => [row.id, row]))

  async function close(task: Task, action: 'complete' | 'cancel') {
    setError('')
    const result = await send(`crm.task.${action}`, 'POST', `/tasks/${task.id}/${action}`, {
      fallback: t('agenda.failed'),
    })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNotice(t(action === 'complete' ? 'agenda.completed' : 'agenda.cancelled'))
    await onChanged()
  }

  if (tasks.length === 0) return <Empty copy={t('agenda.empty')} />
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="panel table-panel table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('agenda.task')}</th>
              <th>{t('table.account')}</th>
              <th>{t('agenda.due')}</th>
              <th>{t('agenda.reminder')}</th>
              <th aria-label={t('opportunity.actions')} />
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <Link href={subjectLink(task)}>{task.title ?? t('timeline.erasedText')}</Link>
                </td>
                <td>{accountName(accounts.get(task.accountId), t('unknownAccount'))}</td>
                <td>
                  {when(task.dueAt)}{' '}
                  {task.overdue ? <Badge label={t('agenda.overdue')} status="overdue" /> : null}
                </td>
                <td>{task.remindAt ? when(task.remindAt) : '—'}</td>
                <td className="crm-row-actions">
                  {abilities.canWrite ? (
                    <>
                      <Button
                        aria-label={t('agenda.completeTask', { title: task.title ?? '' })}
                        onClick={() => close(task, 'complete')}
                        variant="secondary"
                      >
                        {t('agenda.complete')}
                      </Button>
                      <Button onClick={() => close(task, 'cancel')} variant="ghost">
                        {t('agenda.cancel')}
                      </Button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
