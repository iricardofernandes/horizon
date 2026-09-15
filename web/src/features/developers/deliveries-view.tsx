'use client'

import { Dialog } from '@base-ui/react/dialog'
import { ArrowClockwise, Eye, X } from '@phosphor-icons/react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty } from '@/components/ui/state'
import { dateTimeOf, short } from '@/lib/format'
import { tracedFetch } from '@/lib/telemetry'

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
  return (
    <section>
      <PageHeading
        eyebrow="Developer operations"
        title="Delivery logs"
        copy="Every attempt the durable queue has made, with its response and its retries."
      />
      <section className="panel delivery-panel">
        <PanelHeading title="Recent deliveries" copy="Attempt status from the durable queue" />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code className="table-code">{row.eventType}</code>
                  </td>
                  <td>
                    <Badge status={row.status} />
                  </td>
                  <td>{row.attemptCount}</td>
                  <td>{dateTimeOf(row.updatedAt)}</td>
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
          {!deliveries.length ? <Empty copy="Deliveries appear after a confirmed order." /> : null}
        </div>
      </section>
    </section>
  )
}

function DeliveryDetailsDialog({ delivery }: { delivery: Delivery }) {
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
        <Eye aria-hidden="true" size={15} /> Attempts
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Delivery attempts</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {delivery.eventType} · event {short(delivery.eventId)}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="delivery-summary">
            <div>
              <span className="summary-label">Status</span>
              <Badge status={delivery.status} />
            </div>
            <div>
              <span className="summary-label">Last HTTP status</span>
              <strong>{delivery.lastResponseStatus ?? '—'}</strong>
            </div>
            <div>
              <span className="summary-label">Attempts</span>
              <strong>{delivery.attemptCount}</strong>
            </div>
          </div>
          <div className="attempt-list">
            {attempts.map((attempt) => (
              <article key={attempt.id}>
                <span className="attempt-number">#{attempt.attemptNumber}</span>
                <span>
                  <strong>
                    {attempt.responseStatus ? `HTTP ${attempt.responseStatus}` : 'Connection error'}
                  </strong>
                  <small>
                    {dateTimeOf(attempt.attemptedAt)} · {attempt.durationMs} ms
                  </small>
                </span>
                <Badge status={attempt.error ? 'rejected' : 'succeeded'} />
                {attempt.error ? <p>{attempt.error}</p> : null}
              </article>
            ))}
            {loading ? <p className="empty">Loading attempts…</p> : null}
            {!loading && !attempts.length ? (
              <p className="empty">No delivery attempt has run yet.</p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">Close</Dialog.Close>
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
  const [busy, setBusy] = useState(false)
  async function replay() {
    setBusy(true)
    const response = await tracedFetch(
      'webhook.delivery.replay',
      `/api/horizon/webhooks/webhook-deliveries/${delivery.id}/replay`,
      { method: 'POST' },
    )
    setNotice(response.ok ? 'Delivery queued for replay.' : 'The delivery could not be replayed.')
    if (response.ok) await onChanged()
    setBusy(false)
  }
  return (
    <Button disabled={busy} onClick={replay} type="button">
      <ArrowClockwise aria-hidden="true" size={15} /> {busy ? 'Replaying…' : 'Replay'}
    </Button>
  )
}
