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
import { useDate, useMoney } from '@/lib/use-format'
import {
  type OrderDetail,
  type OrderRow,
  PROCUREMENT_API,
  type PurchasingAbilities,
  type Receipt,
} from './types'

type Arriving = Record<string, string>

/**
 * One order, everything that has arrived against it, and the conference for what arrives
 * next.
 *
 * The conference is the table: each line shows what was ordered, what has already come and
 * what is still outstanding, and the field starts at the outstanding quantity — because
 * that is what a delivery usually is, and because a number somebody has to retype is a
 * number somebody mistypes.
 */
export function OrderDialog({
  order,
  abilities,
  onClose,
  onChanged,
}: {
  order: OrderRow
  abilities: PurchasingAbilities
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const common = useTranslations('common')
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [loaded, delivered] = await Promise.all([
        readJson<OrderDetail>('procurement.order', `${PROCUREMENT_API}/orders/${order.id}`),
        readJson<Receipt[]>(
          'procurement.receipts',
          `${PROCUREMENT_API}/orders/${order.id}/receipts`,
        ),
      ])
      setDetail(loaded)
      setReceipts(delivered)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [order.id])

  useEffect(() => {
    void load()
  }, [load])

  const command = async (
    name: string,
    path: string,
    body: unknown,
    idempotent = false,
  ): Promise<void> => {
    setBusy(true)
    setError('')
    const response = await tracedFetch(name, path, {
      method: 'POST',
      headers: idempotent ? idempotentJsonHeaders() : jsonHeaders(),
      body: JSON.stringify(body),
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
              detail={detail}
              error={error}
              onCommand={command}
              receipts={receipts}
            />
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Body({
  detail,
  receipts,
  abilities,
  busy,
  error,
  onCommand,
}: {
  detail: OrderDetail
  receipts: readonly Receipt[]
  abilities: PurchasingAbilities
  busy: boolean
  error: string
  onCommand: (name: string, path: string, body: unknown, idempotent?: boolean) => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const label = useStatusLabel()
  const date = useDate()
  const money = useMoney()
  const [arriving, setArriving] = useState<Arriving>({})
  const [reason, setReason] = useState('')
  const [override, setOverride] = useState('')
  const base = `${PROCUREMENT_API}/orders/${detail.id}`
  const receiving = detail.status === 'approved' || detail.status === 'received'
  // The conference only counts when there is an order to count against, and a reader who
  // may not record a delivery is shown the figures without a field to type into.
  const counting = receiving && abilities.canWrite
  const decidable =
    detail.status === 'pending' &&
    abilities.canDecide &&
    detail.approvalRequestedBy !== abilities.userId
  const lines = Object.entries(arriving)
    .filter(([, quantity]) => quantity.trim() !== '' && Number(quantity) > 0)
    .map(([lineId, quantity]) => ({ lineId, quantity: quantity.trim() }))

  return (
    <>
      <div className="dialog-heading">
        <Dialog.Title>{t('orderTitle', { id: detail.id.slice(-8).toUpperCase() })}</Dialog.Title>
        <Badge label={label(detail.status)} status={detail.status} />
      </div>
      <dl className="document-facts">
        <div>
          <dt>{t('supplier')}</dt>
          <dd>{detail.supplierName}</dd>
        </div>
        <div>
          <dt>{t('issuedOn')}</dt>
          <dd>{date(detail.issuedOn)}</dd>
        </div>
        <div>
          <dt>{t('expectedOn')}</dt>
          <dd>{date(detail.expectedOn)}</dd>
        </div>
        <div>
          <dt>{t('total')}</dt>
          <dd>{money(detail.total, detail.currency)}</dd>
        </div>
      </dl>

      <h3 className="document-section-title">{t('conference')}</h3>
      <Conference
        arriving={arriving}
        counting={counting}
        detail={detail}
        onArriving={setArriving}
      />

      {counting ? (
        <div className="document-commit">
          <label className="document-reason">
            <span className="ledger-field-label">{t('overrideReason')}</span>
            <input
              className="ui-input"
              onChange={(event) => setOverride(event.target.value)}
              placeholder={t('overrideHint')}
              value={override}
            />
          </label>
          <Button
            disabled={busy || lines.length === 0}
            onClick={() =>
              onCommand(
                'procurement.receive',
                `${PROCUREMENT_API}/receipts`,
                {
                  orderId: detail.id,
                  receivedOn: new Date().toISOString().slice(0, 10),
                  lines,
                  ...(override.trim().length >= 3 ? { overrideReason: override.trim() } : {}),
                },
                true,
              ).then(() => setArriving({}))
            }
            type="button"
          >
            {t('receive')}
          </Button>
        </div>
      ) : null}

      <h3 className="document-section-title">{t('deliveries')}</h3>
      <Deliveries
        busy={busy}
        canReturn={abilities.canWrite}
        onCommand={onCommand}
        reason={reason}
        receipts={receipts}
      />

      {error ? <Notice copy={error} /> : null}

      <div className="dialog-actions">
        <label className="document-reason">
          <span className="ledger-field-label">{t('reason')}</span>
          <input
            className="ui-input"
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </label>
        {detail.status === 'draft' && abilities.canCommit ? (
          <Button
            disabled={busy}
            onClick={() => onCommand('procurement.order.place', `${base}/place`, {})}
            type="button"
          >
            {t('place')}
          </Button>
        ) : null}
        {decidable ? (
          <>
            <Button
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                onCommand('procurement.order.reject', `${base}/reject`, { reason: reason.trim() })
              }
              type="button"
              variant="secondary"
            >
              {t('reject')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => onCommand('procurement.order.approve', `${base}/approve`, {})}
              type="button"
            >
              {t('approve')}
            </Button>
          </>
        ) : null}
        {receiving && abilities.canCommit ? (
          <Button
            disabled={busy || reason.trim().length < 3}
            onClick={() =>
              onCommand('procurement.order.close', `${base}/close`, { reason: reason.trim() })
            }
            type="button"
            variant="secondary"
          >
            {t('close')}
          </Button>
        ) : null}
      </div>
    </>
  )
}

/** What was ordered, what has come, and what a reader is counting in right now. */
function Conference({
  detail,
  counting,
  arriving,
  onArriving,
}: {
  detail: OrderDetail
  counting: boolean
  arriving: Arriving
  onArriving: (update: (current: Arriving) => Arriving) => void
}) {
  const t = useTranslations('purchasing')
  const money = useMoney()
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('line')}</th>
            <th className="numeric">{t('ordered')}</th>
            <th className="numeric">{t('received')}</th>
            <th className="numeric">{t('outstanding')}</th>
            <th className="numeric">{t('unitPrice')}</th>
            {counting ? <th className="numeric">{t('arriving')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {detail.data.map((line) => (
            <tr key={line.lineId}>
              <td>{line.description}</td>
              <td className="numeric">{line.quantity}</td>
              <td className="numeric">{line.received}</td>
              <td className="numeric">{line.outstanding}</td>
              <td className="numeric">{money(line.unitPrice, detail.currency)}</td>
              {counting ? (
                <td className="numeric">
                  <input
                    aria-label={t('arrivingFor', { line: line.description })}
                    className="ui-input document-quantity"
                    inputMode="decimal"
                    onChange={(event) =>
                      onArriving((current) => ({ ...current, [line.lineId]: event.target.value }))
                    }
                    placeholder={line.outstanding}
                    value={arriving[line.lineId] ?? ''}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Everything that has arrived, oldest first, with what it was worth and what went back. */
function Deliveries({
  receipts,
  canReturn,
  busy,
  reason,
  onCommand,
}: {
  receipts: readonly Receipt[]
  canReturn: boolean
  busy: boolean
  reason: string
  onCommand: (name: string, path: string, body: unknown, idempotent?: boolean) => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const label = useStatusLabel()
  const date = useDate()
  const money = useMoney()
  if (receipts.length === 0) return <p className="document-note">{t('noDeliveries')}</p>
  return (
    <ul className="document-timeline">
      {receipts.map((receipt) => (
        <li key={receipt.id}>
          <div className="document-timeline-head">
            <strong>{date(receipt.receivedOn)}</strong>
            <Badge label={label(receipt.status)} status={receipt.status} />
            <span>{money(receipt.value, receipt.currency)}</span>
          </div>
          <p className="document-note">
            {receipt.lines.map((line) => `${line.description} × ${line.quantity}`).join(', ')}
          </p>
          {receipt.overrideReason ? (
            <p className="document-note">{t('overReceipt', { reason: receipt.overrideReason })}</p>
          ) : null}
          {receipt.returnReason ? (
            <p className="document-note">{t('returnedFor', { reason: receipt.returnReason })}</p>
          ) : null}
          {receipt.status === 'recorded' && canReturn ? (
            <Button
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                onCommand(
                  'procurement.return',
                  `${PROCUREMENT_API}/receipts/${receipt.id}/return`,
                  {
                    reason: reason.trim(),
                  },
                )
              }
              type="button"
              variant="secondary"
            >
              {t('sendBack')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
