'use client'

import { useTranslations } from 'next-intl'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { Notice } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { apiError } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'

export type QueueItem = {
  id: string
  requestedBy: string | null
  requestedAt: string
  /** What is waiting, in the module's own words: amount, accounts, reference. */
  summary: ReactNode
}

/**
 * What waits for a second person (ADR 0062, screens since Phase 70). Anyone with a role in the
 * module sees the queue; the module decides who may approve, and refuses the person who asked,
 * naming the pair. A refusal always says why.
 */
export function ApprovalQueue({
  title,
  copy,
  api,
  path,
  telemetry,
  items,
  onDecided,
}: {
  title: string
  copy: string
  /** The module's web API root, e.g. `/api/horizon/treasury`. */
  api: string
  /** The collection the items belong to, e.g. `transfers`. */
  path: string
  telemetry: string
  items: readonly QueueItem[]
  onDecided: (notice: string) => Promise<void>
}) {
  const t = useTranslations('approvals')
  if (!items.length) return null
  return (
    <section className="panel table-panel approval-queue">
      <PanelHeading copy={copy} title={title} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('requested')}</th>
              <th>{t('what')}</th>
              <th>{t('decision')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <QueueRow
                api={api}
                item={item}
                key={item.id}
                onDecided={onDecided}
                path={path}
                telemetry={telemetry}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function QueueRow({
  item,
  api,
  path,
  telemetry,
  onDecided,
}: {
  item: QueueItem
  api: string
  path: string
  telemetry: string
  onDecided: (notice: string) => Promise<void>
}) {
  const t = useTranslations('approvals')
  const dateTime = useDateTime()
  const [rejecting, setRejecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function decide(decision: 'approve' | 'reject', reason?: string) {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      `${telemetry}.${decision}`,
      `${api}/${path}/${item.id}/${decision}`,
      {
        method: 'POST',
        headers: idempotentJsonHeaders(),
        ...(reason === undefined ? {} : { body: JSON.stringify({ reason }) }),
      },
    )
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('failed')))
      return
    }
    setRejecting(false)
    await onDecided(decision === 'approve' ? t('approved') : t('rejected'))
  }

  return (
    <tr>
      <td>
        {dateTime(item.requestedAt)}
        <br />
        <small>{item.requestedBy ?? t('unknownRequester')}</small>
      </td>
      <td>{item.summary}</td>
      <td>
        {error ? <Notice copy={error} /> : null}
        {rejecting ? (
          <form
            className="receivable-inline-form"
            onSubmit={(event) => {
              event.preventDefault()
              void decide('reject', String(new FormData(event.currentTarget).get('reason') ?? ''))
            }}
          >
            <TextField label={t('reason')} maxLength={500} minLength={3} name="reason" required />
            <div className="dialog-actions">
              <Button onClick={() => setRejecting(false)} type="button" variant="secondary">
                {t('keep')}
              </Button>
              <Button disabled={busy} type="submit" variant="danger">
                {t('reject')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="dialog-actions">
            <Button
              disabled={busy}
              onClick={() => void decide('approve')}
              type="button"
              variant="primary"
            >
              {t('approve')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setRejecting(true)}
              type="button"
              variant="secondary"
            >
              {t('reject')}
            </Button>
          </div>
        )}
      </td>
    </tr>
  )
}
