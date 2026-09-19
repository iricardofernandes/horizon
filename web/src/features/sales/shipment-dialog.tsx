'use client'

import { Dialog } from '@base-ui/react/dialog'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingState, Notice } from '@/components/ui/state'
import { apiError, readJson } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useMoney, useQuantity } from '@/lib/use-format'
import type { SalesScreenData } from './sales-page'
import { reference, SALES_API, type SalesAbilities, type Shipment } from './types'

type Command = (name: string, path: string, body?: unknown, idempotent?: boolean) => Promise<void>

/**
 * One delivery, from the shelf to the van and — when it comes to that — back again.
 *
 * What the box is worth is its share of the order's total, decided by Sales rather than
 * by this screen: freight and the discount were agreed for the order as a whole, so no
 * arithmetic here could get it right on its own.
 */
export function ShipmentDialog({
  shipment,
  data,
  abilities,
  onClose,
  onChanged,
}: {
  shipment: Shipment
  data: SalesScreenData
  abilities: SalesAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('sales')
  const common = useTranslations('common')
  const [detail, setDetail] = useState<Shipment | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setDetail(await readJson<Shipment>('sales.shipment', `${SALES_API}/shipments/${shipment.id}`))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [shipment.id])

  useEffect(() => {
    void load()
  }, [load])

  const command: Command = async (name, path, body, idempotent = false) => {
    setBusy(true)
    setError('')
    const response = await tracedFetch(name, path, {
      method: 'POST',
      headers: idempotent ? idempotentJsonHeaders() : jsonHeaders(),
      body: JSON.stringify(body ?? {}),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    await Promise.all([load(), onChanged()])
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
            <Body
              abilities={abilities}
              busy={busy}
              data={data}
              detail={detail}
              error={error}
              onCommand={command}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({
  detail,
  data,
  abilities,
  busy,
  error,
  onCommand,
}: {
  detail: Shipment
  data: SalesScreenData
  abilities: SalesAbilities
  busy: boolean
  error: string
  onCommand: Command
}) {
  const t = useTranslations('sales')
  const label = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  const quantity = useQuantity()
  const order = data.orders.find((row) => row.id === detail.orderId)
  const customer = data.customers.find((row) => row.id === order?.customerId)
  const warehouse = data.warehouses.find((row) => row.id === detail.warehouseId)

  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>{t('shipmentTitle', { id: reference('SH', detail.id) })}</Dialog.Title>
        <Badge label={label(detail.status)} status={detail.status} />
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('order')}</dt>
          <dd>{reference('SO', detail.orderId)}</dd>
        </div>
        <div>
          <dt>{t('customer')}</dt>
          <dd>{customer?.name ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('warehouse')}</dt>
          <dd>{warehouse?.name ?? reference('WH', detail.warehouseId)}</dd>
        </div>
        <div>
          <dt>{t('value')}</dt>
          <dd>{money(detail.value.amount, detail.value.currency)}</dd>
        </div>
        <div>
          <dt>{t('carrier')}</dt>
          <dd>
            {detail.carrier ?? '—'}
            {detail.trackingCode ? ` · ${detail.trackingCode}` : ''}
          </dd>
        </div>
        <div>
          <dt>{t('dispatchedOn')}</dt>
          <dd>{detail.dispatchedOn ? date(detail.dispatchedOn) : '—'}</dd>
        </div>
      </dl>

      <h3 className="document-section-title">{t('inTheBox')}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('line')}</th>
              <th className="numeric">{t('quantity')}</th>
              <th className="numeric">{t('unitPrice')}</th>
              <th className="numeric">{t('lineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.lineId}>
                <td>{line.description}</td>
                <td className="numeric">{quantity(line.quantity)}</td>
                <td className="numeric">{money(line.unitPrice.amount, line.unitPrice.currency)}</td>
                <td className="numeric">{money(line.lineTotal.amount, line.lineTotal.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail.closureReason ? (
        <p className="document-note">{t('closedFor', { reason: detail.closureReason })}</p>
      ) : null}
      {error ? <Notice copy={error} /> : null}

      {abilities.canWrite ? <Steps busy={busy} detail={detail} onCommand={onCommand} /> : null}
    </>
  )
}

/** The next physical step, and the two ways a delivery stops being one. */
function Steps({
  detail,
  busy,
  onCommand,
}: {
  detail: Shipment
  busy: boolean
  onCommand: Command
}) {
  const t = useTranslations('sales')
  const [carrier, setCarrier] = useState(detail.carrier ?? '')
  const [tracking, setTracking] = useState(detail.trackingCode ?? '')
  const [reason, setReason] = useState('')
  const base = `${SALES_API}/shipments/${detail.id}`
  const reasoned = reason.trim().length >= 3
  const consignment = {
    ...(carrier.trim().length >= 2 ? { carrier: carrier.trim() } : {}),
    ...(tracking.trim() ? { trackingCode: tracking.trim() } : {}),
  }
  const open = detail.status === 'picking' || detail.status === 'packed'

  return (
    <>
      {open ? (
        <div className="document-consignment">
          <label className="document-reason">
            <span className="ui-field-label">{t('carrier')}</span>
            <input
              className="ui-input"
              onChange={(event) => setCarrier(event.target.value)}
              value={carrier}
            />
          </label>
          <label className="document-reason">
            <span className="ui-field-label">{t('trackingCode')}</span>
            <input
              className="ui-input"
              onChange={(event) => setTracking(event.target.value)}
              value={tracking}
            />
          </label>
        </div>
      ) : null}
      <div className="dialog-actions">
        {detail.status === 'dispatched' || open ? (
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
            disabled={busy || !reasoned}
            onClick={() => onCommand('sales.shipment.abandon', `${base}/abandon`, { reason })}
            variant="secondary"
          >
            {t('abandon')}
          </Button>
        ) : null}
        {detail.status === 'picking' ? (
          <Button
            disabled={busy}
            onClick={() => onCommand('sales.shipment.pack', `${base}/pack`, { consignment })}
          >
            {t('pack')}
          </Button>
        ) : null}
        {detail.status === 'packed' ? (
          <Button
            disabled={busy}
            onClick={() =>
              onCommand('sales.shipment.dispatch', `${base}/dispatch`, { consignment }, true)
            }
            variant="primary"
          >
            {t('dispatch')}
          </Button>
        ) : null}
        {detail.status === 'dispatched' ? (
          <Button
            disabled={busy || !reasoned}
            onClick={() =>
              onCommand('sales.shipment.return', `${base}/return`, { reason: reason.trim() }, true)
            }
            variant="secondary"
          >
            {t('takeBack')}
          </Button>
        ) : null}
      </div>
    </>
  )
}
