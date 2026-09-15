'use client'

import { Dialog } from '@base-ui/react/dialog'
import { ArrowClockwise, Eye, X } from '@phosphor-icons/react'
import { useFormatter, useTranslations } from 'next-intl'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty } from '@/components/ui/state'
import { short } from '@/lib/format'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'

export type Delivery = {
  id: string
  subscriptionId: string
  eventId: string
  eventType: string
  status: string
  attemptCount: number
  nextAttemptAt: string | null
  lastResponseStatus: number | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

type DeliveryAttempt = {
  id: string
  attemptNumber: number
  attemptedAt: string
  durationMs: number
  responseStatus: number | null
  error: string | null
}

export function DeliveriesView({
  deliveries,
  onChanged,
  setNotice,
}: {
  deliveries: Delivery[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('deliveries')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  return (
    <section>
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <section className="panel delivery-panel">
        <PanelHeading title={t('panelTitle')} copy={t('panelCopy')} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('event')}</th>
                <th>{t('status')}</th>
                <th>{t('attemptsColumn')}</th>
                <th>{t('updated')}</th>
                <th aria-label={common('actions')} />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code className="table-code">{row.eventType}</code>
                  </td>
                  <td>
                    <Badge status={row.status} label={statusLabel(row.status)} />
                  </td>
                  <td>{row.attemptCount}</td>
                  <td>{dateTime(row.updatedAt)}</td>
                  <td>
                    <div className="row-actions">
                      <DeliveryDetailsDialog delivery={row} />
                      {row.status === 'dead-letter' ? (
                        <ReplayDeliveryButton
                          delivery={row}
                          onChanged={onChanged}
                          setNotice={setNotice}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deliveries.length ? <Empty copy={t('empty')} /> : null}
        </div>
      </section>
    </section>
  )
}

function DeliveryDetailsDialog({ delivery }: { delivery: Delivery }) {
  const t = useTranslations('deliveries')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const dateTime = useDateTime()
  const format = useFormatter()
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([])
  const [loading, setLoading] = useState(false)
  async function changed(open: boolean) {
    if (!open) return
    setLoading(true)
    const response = await tracedFetch(
      'webhook.delivery.attempts',
      `/api/horizon/webhooks/webhook-deliveries/${delivery.id}/attempts`,
    )
    if (response.ok) setAttempts(await response.json())
    setLoading(false)
  }
  return (
    <Dialog.Root onOpenChange={changed}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Eye aria-hidden="true" size={15} /> {t('viewAttempts')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('dialogTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('dialogDescription', {
                eventType: delivery.eventType,
                eventId: short(delivery.eventId),
              })}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="delivery-summary">
            <div>
              <span className="summary-label">{t('status')}</span>
              <Badge status={delivery.status} label={statusLabel(delivery.status)} />
            </div>
            <div>
              <span className="summary-label">{t('lastHttpStatus')}</span>
              <strong>{delivery.lastResponseStatus ?? '—'}</strong>
            </div>
            <div>
              <span className="summary-label">{t('attempts')}</span>
              <strong>{delivery.attemptCount}</strong>
            </div>
          </div>
          <div className="attempt-list">
            {attempts.map((attempt) => (
              <article key={attempt.id}>
                <span className="attempt-number">#{attempt.attemptNumber}</span>
                <span>
                  <strong>
                    {attempt.responseStatus
                      ? t('httpStatus', { status: attempt.responseStatus })
                      : t('connectionError')}
                  </strong>
                  <small>
                    {dateTime(attempt.attemptedAt)} · {format.number(attempt.durationMs)} ms
                  </small>
                </span>
                <Badge
                  status={attempt.error ? 'rejected' : 'succeeded'}
                  label={statusLabel(attempt.error ? 'rejected' : 'succeeded')}
                />
                {attempt.error ? <p>{attempt.error}</p> : null}
              </article>
            ))}
            {loading ? <p className="empty">{t('loadingAttempts')}</p> : null}
            {!loading && !attempts.length ? <p className="empty">{t('noAttempts')}</p> : null}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">{common('close')}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ReplayDeliveryButton({
  delivery,
  onChanged,
  setNotice,
}: {
  delivery: Delivery
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('deliveries')
  const [busy, setBusy] = useState(false)
  async function replay() {
    setBusy(true)
    const response = await tracedFetch(
      'webhook.delivery.replay',
      `/api/horizon/webhooks/webhook-deliveries/${delivery.id}/replay`,
      { method: 'POST' },
    )
    setNotice(response.ok ? t('replayQueued') : t('replayFailed'))
    if (response.ok) await onChanged()
    setBusy(false)
  }
  return (
    <Button disabled={busy} onClick={replay} type="button">
      <ArrowClockwise aria-hidden="true" size={15} /> {busy ? t('replaying') : t('replay')}
    </Button>
  )
}
