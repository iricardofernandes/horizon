'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import { AttachmentsPanel } from '@/features/attachments/attachments-panel'
import { reference } from '@/features/sales/types'
import { readJson } from '@/lib/api'
import { useStatusLabel } from '@/lib/status'
import { useDate, useMoney, useQuantity } from '@/lib/use-format'
import { NfseEffectCell, ReceivableEffectCell } from './effects'
import { command, nameOf, type ServicesData } from './services-data'
import {
  deliveryReference,
  remainingOf,
  SALES_API,
  type ServiceDelivery,
  type ServiceOrder,
} from './types'

type Run = (name: string, path: string, body?: unknown, idempotent?: boolean) => Promise<boolean>

/** Today where the person is, since work is recorded on the day it was done locally. */
function localToday(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/**
 * One service order: what was sold, what was delivered, and what each delivery raised in
 * Financial and Fiscal. The work moves forward from here, stage by stage.
 */
export function ServiceOrderDialog({
  orderId,
  data,
  canWrite,
  onClose,
  onChanged,
}: {
  orderId: string
  data: ServicesData
  canWrite: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('services')
  const common = useTranslations('common')
  const [detail, setDetail] = useState<ServiceOrder | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setDetail(
        await readJson<ServiceOrder>(
          'sales.service-order',
          `${SALES_API}/service-orders/${orderId}`,
        ),
      )
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [orderId])

  useEffect(() => {
    void load()
  }, [load])

  const run: Run = async (name, path, body, idempotent = false) => {
    setBusy(true)
    setError('')
    const result = await command(name, path, { body, idempotent, fallback: t('failed') })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    await Promise.all([load(), onChanged()])
    return true
  }

  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {failed ? <Notice copy={t('detailUnavailable')} /> : null}
          {!failed && !detail ? <LoadingState /> : null}
          {detail ? (
            <>
              <Body
                busy={busy}
                canWrite={canWrite}
                data={data}
                detail={detail}
                error={error}
                run={run}
              />
              <AttachmentsPanel
                record={{
                  module: 'sales',
                  recordType: 'service-order',
                  recordId: detail.id,
                  ownerPartyId: detail.customerId,
                }}
              />
            </>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({
  detail,
  data,
  canWrite,
  busy,
  error,
  run,
}: {
  detail: ServiceOrder
  data: ServicesData
  canWrite: boolean
  busy: boolean
  error: string
  run: Run
}) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const quantity = useQuantity()
  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>{t('orders.detailTitle', { id: reference('OS', detail.id) })}</Dialog.Title>
        <Badge label={label(detail.status)} status={detail.status} />
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('customer')}</dt>
          <dd>{nameOf(data.customers, detail.customerId)}</dd>
        </div>
        <div>
          <dt>{t('orders.openedOn')}</dt>
          <dd>{date(detail.openedOn)}</dd>
        </div>
        <div>
          <dt>{t('total')}</dt>
          <dd>{money(detail.total, detail.currency)}</dd>
        </div>
        <div>
          <dt>{t('orders.billed')}</dt>
          <dd>{money(detail.billed, detail.currency)}</dd>
        </div>
        <div>
          <dt>{t('discount')}</dt>
          <dd>{money(detail.discount, detail.currency)}</dd>
        </div>
        <div>
          <dt>{t('orders.proposal')}</dt>
          <dd>{detail.quoteId ? reference('QT', detail.quoteId) : '—'}</dd>
        </div>
      </dl>

      <h3 className="document-section-title">{t('orders.linesTitle')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('serviceColumn')}</th>
              <th className="numeric">{t('quantity')}</th>
              <th className="numeric">{t('orders.deliveredQuantity')}</th>
              <th className="numeric">{t('orders.remaining')}</th>
              <th className="numeric">{t('lineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.lineId}>
                <td>{line.description}</td>
                <td className="numeric">{quantity(line.quantity)}</td>
                <td className="numeric">{quantity(line.delivered)}</td>
                <td className="numeric">{quantity(remainingOf(line))}</td>
                <td className="numeric">{money(line.lineTotal, detail.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="document-section-title">{t('orders.deliveriesTitle')}</h3>
      {detail.deliveries.length === 0 ? (
        <p className="document-note">{t('orders.noDeliveries')}</p>
      ) : (
        <Deliveries busy={busy} canWrite={canWrite} detail={detail} run={run} />
      )}

      {detail.closureReason ? (
        <p className="document-note">{t('closedFor', { reason: detail.closureReason })}</p>
      ) : null}
      {error ? <Notice copy={error} /> : null}
      {canWrite ? (
        <Steps busy={busy} detail={detail} key={detail.deliveries.length} run={run} />
      ) : null}
    </>
  )
}

function Deliveries({
  detail,
  canWrite,
  busy,
  run,
}: {
  detail: ServiceOrder
  canWrite: boolean
  busy: boolean
  run: Run
}) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('orders.delivery')}</th>
            <th>{t('orders.performedOn')}</th>
            <th className="numeric">{t('value')}</th>
            <th>{t('effects.receivable')}</th>
            <th>{t('effects.nfse')}</th>
            <th aria-label={t('actions')} />
          </tr>
        </thead>
        <tbody>
          {detail.deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td>
                <code>{deliveryReference(delivery.id)}</code>{' '}
                <Badge label={label(delivery.status)} status={delivery.status} />
              </td>
              <td>{date(delivery.performedOn)}</td>
              <td className="numeric">{money(delivery.value, detail.currency)}</td>
              <td>
                <ReceivableEffectCell
                  effect={delivery.receivable}
                  reference={deliveryReference(delivery.id)}
                  withdrawn={delivery.status === 'cancelled'}
                />
              </td>
              <td>
                {delivery.entries.map((entry) => (
                  <div key={entry.entryId}>
                    <NfseEffectCell effect={entry.nfse} />
                  </div>
                ))}
              </td>
              <td>
                {canWrite && delivery.status === 'active' ? (
                  <CancelDelivery busy={busy} delivery={delivery} orderId={detail.id} run={run} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A delivery that was not provided: cancelled with a reason, kept in the record. */
function CancelDelivery({
  delivery,
  orderId,
  busy,
  run,
}: {
  delivery: ServiceDelivery
  orderId: string
  busy: boolean
  run: Run
}) {
  const t = useTranslations('services')
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  if (!asking)
    return (
      <Button onClick={() => setAsking(true)} type="button" variant="secondary">
        {t('orders.cancelDelivery')}
      </Button>
    )
  return (
    <span className="inline-reason">
      <input
        aria-label={t('reason')}
        className="ui-input"
        onChange={(event) => setReason(event.target.value)}
        value={reason}
      />
      <Button
        disabled={busy || reason.trim().length < 3}
        onClick={() =>
          run(
            'sales.service-delivery.cancel',
            `${SALES_API}/service-orders/${orderId}/deliveries/${delivery.id}/cancel`,
            { reason: reason.trim() },
          )
        }
        type="button"
        variant="secondary"
      >
        {t('confirm')}
      </Button>
    </span>
  )
}

/** The next step of the order's stage, and the way it stops. */
function Steps({ detail, busy, run }: { detail: ServiceOrder; busy: boolean; run: Run }) {
  const t = useTranslations('services')
  const [reason, setReason] = useState('')
  const [performedOn, setPerformedOn] = useState(localToday)
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(detail.lines.map((line) => [line.lineId, remainingOf(line)])),
  )
  const base = `${SALES_API}/service-orders/${detail.id}`
  const open = detail.status === 'scheduled' || detail.status === 'in_progress'
  const delivering = detail.lines
    .map((line) => ({ lineId: line.lineId, quantity: quantities[line.lineId] ?? '0' }))
    .filter((line) => Number(line.quantity) > 0)

  return (
    <>
      {detail.status === 'in_progress' ? (
        <div className="service-deliver">
          <h3 className="document-section-title">{t('orders.deliverTitle')}</h3>
          {detail.lines
            .filter((line) => Number(remainingOf(line)) > 0)
            .map((line) => (
              <label className="document-reason" key={line.lineId}>
                <span className="ui-field-label">
                  {t('orders.deliverLine', { line: line.description })}
                </span>
                <input
                  className="ui-input"
                  inputMode="decimal"
                  onChange={(event) =>
                    setQuantities((current) => ({ ...current, [line.lineId]: event.target.value }))
                  }
                  value={quantities[line.lineId] ?? ''}
                />
              </label>
            ))}
          <label className="document-reason">
            <span className="ui-field-label">{t('orders.performedOn')}</span>
            <input
              className="ui-input"
              onChange={(event) => setPerformedOn(event.target.value)}
              type="date"
              value={performedOn}
            />
          </label>
        </div>
      ) : null}
      <div className="dialog-actions">
        {open ? (
          <label className="document-reason">
            <span className="ui-field-label">{t('reason')}</span>
            <input
              className="ui-input"
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
          </label>
        ) : null}
        {open ? (
          <Button
            disabled={busy || reason.trim().length < 3}
            onClick={() =>
              run('sales.service-order.cancel', `${base}/cancel`, { reason: reason.trim() })
            }
            variant="secondary"
          >
            {t('orders.cancel')}
          </Button>
        ) : null}
        {detail.status === 'scheduled' ? (
          <Button
            disabled={busy}
            onClick={() => run('sales.service-order.start', `${base}/start`)}
            variant="primary"
          >
            {t('orders.start')}
          </Button>
        ) : null}
        {detail.status === 'in_progress' ? (
          <Button
            disabled={busy || delivering.length === 0}
            onClick={() =>
              run(
                'sales.service-order.deliver',
                `${base}/deliveries`,
                { lines: delivering, performedOn },
                true,
              )
            }
            variant="primary"
          >
            {t('orders.deliver')}
          </Button>
        ) : null}
        {detail.status === 'completed' ? (
          <Button
            disabled={busy}
            onClick={() => run('sales.service-order.accept', `${base}/accept`)}
            variant="primary"
          >
            {t('orders.accept')}
          </Button>
        ) : null}
      </div>
    </>
  )
}
