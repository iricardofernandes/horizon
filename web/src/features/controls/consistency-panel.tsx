'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { Resource } from '@/components/ui/resource'
import { Notice } from '@/components/ui/state'
import { apiError, readPage } from '@/lib/api'
import { attentionOf, type ConsistencyRun } from '@/lib/controls'
import { idempotentJsonHeaders } from '@/lib/http'
import { REPORTING_API } from '@/lib/reports'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime, useMoney } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'

async function load() {
  return readPage<ConsistencyRun>(
    'reporting.consistency',
    `${REPORTING_API}/consistency-checks?limit=10`,
  )
}

/**
 * Whether the modules' books agree with the Ledger (ADR 0063): run daily by Reporting, or now
 * by whoever reconciles. A difference names the key and both figures.
 */
export function ConsistencyPanel({ canRun }: { canRun: boolean }) {
  const t = useTranslations('controls')
  const setNotice = useNotice()
  const dateTime = useDateTime()
  const money = useMoney()
  // A difference keyed by a currency is an amount in minor units; any other key is a count.
  const figure = (key: string, value: string) =>
    /^[A-Z]{3}$/.test(key) ? money(value, key) : value
  const state = useLoader(load)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'reporting.consistency.run',
      `${REPORTING_API}/consistency-checks`,
      {
        method: 'POST',
        headers: idempotentJsonHeaders(),
      },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('runFailed')))
      return
    }
    setNotice(t('runDone'))
    await state.reload()
  }

  return (
    <section className="panel table-panel">
      <PanelHeading copy={t('consistencyCopy')} title={t('consistencyTitle')} />
      {error ? <Notice copy={error} /> : null}
      {canRun ? (
        <div className="dialog-actions">
          <Button disabled={busy} onClick={() => void run()} type="button" variant="primary">
            {t('runNow')}
          </Button>
        </div>
      ) : null}
      <Resource state={state}>
        {(runs) =>
          runs.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('startedAt')}</th>
                    <th>{t('trigger')}</th>
                    <th>{t('outcome')}</th>
                    <th>{t('attention')}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((entry) => (
                    <tr key={entry.runId}>
                      <td>{dateTime(entry.startedAt)}</td>
                      <td>{t(`triggers.${entry.trigger}`)}</td>
                      <td>
                        <Badge label={t(`outcomes.${entry.outcome}`)} status={entry.outcome} />
                      </td>
                      <td>
                        {attentionOf(entry).length
                          ? attentionOf(entry)
                              .map((check) =>
                                check.differences.length
                                  ? `${check.check}: ${check.differences
                                      .map((difference) =>
                                        t('difference', {
                                          key: difference.key,
                                          owner: figure(difference.key, difference.owner),
                                          ledger: figure(difference.key, difference.ledger),
                                        }),
                                      )
                                      .join('; ')}`
                                  : `${check.check}: ${check.reason ?? t('unread')}`,
                              )
                              .join(' · ')
                          : t('nothing')}
                        {entry.pendingPostings
                          ? ` · ${t('pendingPostings', { count: entry.pendingPostings })}`
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="catalog-page-copy">{t('noRuns')}</p>
          )
        }
      </Resource>
    </section>
  )
}
