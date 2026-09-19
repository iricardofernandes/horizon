'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Plus, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { apiError } from '@/lib/api'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useQuantity } from '@/lib/use-format'
import { type Order, outstandingOf, reference, SALES_API } from './types'

/**
 * Taking goods off the shelf for a customer.
 *
 * Each field starts at what the line still owes, because that is what a delivery usually
 * is, and because a number somebody has to retype is a number somebody mistypes. Picking
 * holds those quantities against the order, so two boxes prepared at once cannot promise
 * the same unit.
 */
export function PickDialog({
  orders,
  onChanged,
}: {
  orders: readonly Order[]
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('sales')
  const common = useTranslations('common')
  const setNotice = useNotice()
  const quantity = useQuantity()
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState(() => orders[0]?.id ?? '')
  const [picking, setPicking] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const order = orders.find((row) => row.id === orderId) ?? orders[0]
  const owing = (order?.requestedLines ?? []).filter((line) => outstandingOf(line) !== '0')
  const lines = owing
    .map((line) => ({
      lineId: line.lineId,
      quantity: (picking[line.lineId] ?? outstandingOf(line)).trim(),
    }))
    .filter((line) => line.quantity !== '' && Number(line.quantity) > 0)

  async function pick() {
    if (!order) return
    setBusy(true)
    setError('')
    const response = await tracedFetch('sales.shipment.pick', `${SALES_API}/shipments`, {
      method: 'POST',
      headers: idempotentJsonHeaders(),
      body: JSON.stringify({ orderId: order.id, lines }),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await apiError(response, t('actionFailed')))
      return
    }
    setOpen(false)
    setPicking({})
    setNotice(t('picked'))
    await onChanged()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary" disabled={orders.length === 0}>
        <Plus aria-hidden="true" size={17} />
        {t('newDelivery')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('newDeliveryTitle')}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('newDeliveryCopy')}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <SelectField
            label={t('order')}
            name="orderId"
            onValueChange={(value) => {
              setOrderId(value ?? '')
              setPicking({})
            }}
            options={orders.map((row) => ({ label: reference('SO', row.id), value: row.id }))}
            value={order?.id ?? null}
          />
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('line')}</th>
                  <th className="numeric">{t('ordered')}</th>
                  <th className="numeric">{t('shipped')}</th>
                  <th className="numeric">{t('outstanding')}</th>
                  <th className="numeric">{t('picking')}</th>
                </tr>
              </thead>
              <tbody>
                {owing.map((line) => (
                  <tr key={line.lineId}>
                    <td>{line.description ?? reference('IT', line.itemId)}</td>
                    <td className="numeric">{quantity(line.quantity)}</td>
                    <td className="numeric">{quantity(line.shipped)}</td>
                    <td className="numeric">{quantity(outstandingOf(line))}</td>
                    <td className="numeric">
                      <input
                        aria-label={t('pickingFor', {
                          line: line.description ?? reference('IT', line.itemId),
                        })}
                        className="ui-input document-quantity"
                        inputMode="decimal"
                        onChange={(event) =>
                          setPicking((current) => ({
                            ...current,
                            [line.lineId]: event.target.value,
                          }))
                        }
                        placeholder={outstandingOf(line)}
                        value={picking[line.lineId] ?? outstandingOf(line)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">
              {common('cancel')}
            </Dialog.Close>
            <Button
              disabled={busy || lines.length === 0}
              onClick={pick}
              type="button"
              variant="primary"
            >
              {t('pick')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
