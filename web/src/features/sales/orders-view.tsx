'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Eye, Plus, Trash, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import type { Customer } from '@/features/sales/customers-view'
import { short } from '@/lib/format'
import { idempotentJsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useDateTime, useMoney, useQuantity } from '@/lib/use-format'
import { type Order, outstandingOf } from './types'

export type { Order }

export function OrdersView({
  items,
  customers,
  warehouses,
  orders,
  onChanged,
  setNotice,
}: {
  items: CatalogItem[]
  customers: Customer[]
  warehouses: Warehouse[]
  orders: Order[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('orders')
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState([0])
  const [nextLine, setNextLine] = useState(1)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    const data = new FormData(event.currentTarget)
    const created = await createOrder(data)
    if (!created) {
      setNotice(t('createFailed'))
      setBusy(false)
      return
    }
    setNotice(t('orderPlaced', { id: short(created.orderId) }))
    const status = await waitForOrder(created.orderId)
    setNotice(
      status === 'confirmed'
        ? t('orderConfirmed')
        : status === 'rejected'
          ? t('orderRejected')
          : t('orderProcessing'),
    )
    await onChanged()
    setLines([0])
    setNextLine(1)
    setBusy(false)
  }

  function addLine() {
    setLines((current) => [...current, nextLine])
    setNextLine((current) => current + 1)
  }

  return (
    <section>
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <div className="split-grid order-layout">
        <form className="panel form-panel" onSubmit={submit}>
          <PanelHeading title={t('newOrder')} copy={t('newOrderCopy')} />
          <SelectField
            label={t('customer')}
            name="customerId"
            options={customers
              .filter((row) => row.status === 'active')
              .map((row) => ({ label: row.name, value: row.id }))}
            required
          />
          <SelectField
            label={t('warehouse')}
            name="warehouseId"
            options={warehouses
              .filter((row) => row.active)
              .map((row) => ({ label: row.name, value: row.id }))}
            required
          />
          <div className="order-lines-heading">
            <strong>{t('orderLines')}</strong>
            <Button
              disabled={lines.length >= 100}
              onClick={addLine}
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden="true" size={15} /> {t('addLine')}
            </Button>
          </div>
          <div className="order-lines">
            {lines.map((line, index) => (
              <div className="order-line" key={line}>
                <SelectField
                  label={t('item', { index: index + 1 })}
                  name="itemId"
                  options={items
                    .filter((row) => row.active)
                    .map((row) => ({ label: `${row.name} · ${row.sku}`, value: row.id }))}
                  required
                />
                <TextField
                  defaultValue="1"
                  inputMode="decimal"
                  label={t('quantity')}
                  name="quantity"
                  pattern="[0-9]+([.][0-9]{1,6})?"
                  required
                />
                <Button
                  aria-label={t('removeItem', { index: index + 1 })}
                  className="remove-order-line"
                  disabled={lines.length === 1}
                  onClick={() => setLines((current) => current.filter((value) => value !== line))}
                  type="button"
                >
                  <Trash aria-hidden="true" size={16} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            disabled={busy || !customers.length || !warehouses.length || !items.length}
            focusableWhenDisabled
            type="submit"
            variant="primary"
          >
            {busy ? t('placing') : t('placeOrder')}
          </Button>
        </form>
        <section className="panel">
          <PanelHeading title={t('history')} copy={t('historyCopy', { count: orders.length })} />
          <OrderTable orders={orders} customers={customers} warehouses={warehouses} />
        </section>
      </div>
    </section>
  )
}

export function OrderTable({
  orders,
  customers = [],
  warehouses = [],
}: {
  orders: Order[]
  customers?: Customer[]
  warehouses?: Warehouse[]
}) {
  const t = useTranslations('orders')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const date = useDate()
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('order')}</th>
            <th>{t('status')}</th>
            <th>{t('fulfillment')}</th>
            <th>{t('total')}</th>
            <th>{t('placedAt')}</th>
            <th aria-label={common('actions')} />
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => (
            <tr key={row.id}>
              <td>
                <code className="table-code">{short(row.id)}</code>
              </td>
              <td>
                <Badge status={row.status} label={statusLabel(row.status)} />
              </td>
              <td>
                {row.status === 'confirmed' ? (
                  <Badge status={row.fulfillment} label={statusLabel(row.fulfillment)} />
                ) : (
                  '—'
                )}
              </td>
              <td>{row.total ? money(row.total.amount, row.total.currency) : common('pending')}</td>
              <td>{date(row.createdAt)}</td>
              <td>
                <OrderDetailsDialog
                  customer={customers.find((customer) => customer.id === row.customerId)}
                  order={row}
                  warehouse={warehouses.find(
                    (warehouse) => warehouse.id === row.fulfillmentWarehouseId,
                  )}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!orders.length ? <Empty copy={t('empty')} /> : null}
    </div>
  )
}

function OrderDetailsDialog({
  order,
  customer,
  warehouse,
}: {
  order: Order
  customer: Customer | undefined
  warehouse: Warehouse | undefined
}) {
  const t = useTranslations('orders')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const quantity = useQuantity()
  const dateTime = useDateTime()
  const lines = order.confirmedLines.length ? order.confirmedLines : order.requestedLines
  return (
    <Dialog.Root>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Eye aria-hidden="true" size={16} /> {t('details')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>{t('detailTitle', { id: short(order.id) })}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {t('createdAt', { date: dateTime(order.createdAt) })}
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="order-detail-summary">
            <div>
              <span className="summary-label">{t('status')}</span>
              <Badge status={order.status} label={statusLabel(order.status)} />
            </div>
            <div>
              <span className="summary-label">{t('customer')}</span>
              <strong>{customer?.name ?? short(order.customerId)}</strong>
            </div>
            <div>
              <span className="summary-label">{t('warehouse')}</span>
              <strong>{warehouse?.name ?? short(order.fulfillmentWarehouseId)}</strong>
            </div>
            <div>
              <span className="summary-label">{t('total')}</span>
              <strong>
                {order.total ? money(order.total.amount, order.total.currency) : common('pending')}
              </strong>
            </div>
            <div>
              <span className="summary-label">{t('fulfillment')}</span>
              <Badge status={order.fulfillment} label={statusLabel(order.fulfillment)} />
            </div>
            <div>
              <span className="summary-label">{t('deliveries')}</span>
              <strong>{order.shipments}</strong>
            </div>
          </div>
          <div className="order-detail-lines">
            <h3>{t('lines')}</h3>
            {lines.map((line) => {
              const confirmed = isConfirmedOrderLine(line)
              const owed = order.requestedLines.find((row) => row.lineId === line.lineId)
              return (
                <div key={line.lineId}>
                  <span>
                    <strong>
                      {confirmed ? line.description : t('itemFallback', { id: short(line.itemId) })}
                    </strong>
                    <small className="detail-line-meta">
                      {t('quantityLabel', { quantity: line.quantity })}
                      {owed && order.status === 'confirmed'
                        ? ` · ${t('shippedOf', {
                            shipped: quantity(owed.shipped),
                            outstanding: quantity(outstandingOf(owed)),
                          })}`
                        : ''}
                    </small>
                  </span>
                  <strong>
                    {confirmed
                      ? money(line.lineTotal.amount, line.lineTotal.currency)
                      : common('pending')}
                  </strong>
                </div>
              )
            })}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">{common('close')}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function isConfirmedOrderLine(
  line: Order['confirmedLines'][number] | Order['requestedLines'][number],
): line is Order['confirmedLines'][number] {
  return 'lineTotal' in line
}

async function createOrder(data: FormData): Promise<{ orderId: string } | null> {
  const itemIds = data.getAll('itemId')
  const quantities = data.getAll('quantity')
  const response = await tracedFetch('order.create', '/api/horizon/sales/orders', {
    method: 'POST',
    headers: idempotentJsonHeaders(),
    body: JSON.stringify({
      customerId: data.get('customerId'),
      fulfillmentWarehouseId: data.get('warehouseId'),
      lines: itemIds.map((itemId, index) => ({
        lineId: crypto.randomUUID(),
        itemId,
        quantity: quantities[index],
      })),
    }),
  })
  return response.ok ? ((await response.json()) as { orderId: string }) : null
}

async function waitForOrder(orderId: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const response = await tracedFetch('order.poll', `/api/horizon/sales/orders/${orderId}`)
    if (!response.ok) continue
    const order = (await response.json()) as Order
    if (order.status === 'confirmed' || order.status === 'rejected') return order.status
  }
  return 'placed'
}
