'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Eye, Plus, Trash, X } from '@phosphor-icons/react'
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
import { dateOf, dateTimeOf, money, short } from '@/lib/format'
import { idempotentJsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

export type Order = {
  id: string
  status: string
  customerId: string
  fulfillmentWarehouseId: string
  total: { amount: string; currency: string } | null
  createdAt: string
  requestedLines: Array<{ lineId: string; itemId: string; quantity: string }>
  confirmedLines: Array<{
    lineId: string
    itemId: string
    description: string
    quantity: string
    lineTotal: { amount: string; currency: string }
  }>
}

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
      setNotice('The order could not be placed. Verify stock and permissions.')
      setBusy(false)
      return
    }
    setNotice(`Order ${short(created.orderId)} was placed. Waiting for Inventory confirmation…`)
    const status = await waitForOrder(created.orderId)
    setNotice(
      status === 'confirmed'
        ? 'Order confirmed and stock committed.'
        : status === 'rejected'
          ? 'Order rejected because stock was unavailable.'
          : 'The order is still processing. Its status will remain visible here.',
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
      <PageHeading
        eyebrow="Sales workspace"
        title="Orders"
        copy="Place an order and watch the asynchronous stock decision arrive."
      />
      <div className="split-grid order-layout">
        <form className="panel form-panel" onSubmit={submit}>
          <PanelHeading title="New order" copy="One line is enough for the golden path" />
          <SelectField
            label="Customer"
            name="customerId"
            options={customers
              .filter((row) => row.status === 'active')
              .map((row) => ({ label: row.name, value: row.id }))}
            required
          />
          <SelectField
            label="Warehouse"
            name="warehouseId"
            options={warehouses
              .filter((row) => row.active)
              .map((row) => ({ label: row.name, value: row.id }))}
            required
          />
          <div className="order-lines-heading">
            <strong>Order lines</strong>
            <Button
              disabled={lines.length >= 100}
              onClick={addLine}
              type="button"
              variant="secondary"
            >
              <Plus aria-hidden="true" size={15} /> Add line
            </Button>
          </div>
          <div className="order-lines">
            {lines.map((line, index) => (
              <div className="order-line" key={line}>
                <SelectField
                  label={`Item ${index + 1}`}
                  name="itemId"
                  options={items
                    .filter((row) => row.active)
                    .map((row) => ({ label: `${row.name} · ${row.sku}`, value: row.id }))}
                  required
                />
                <TextField
                  defaultValue="1"
                  inputMode="decimal"
                  label="Quantity"
                  name="quantity"
                  pattern="[0-9]+([.][0-9]{1,6})?"
                  required
                />
                <Button
                  aria-label={`Remove item ${index + 1}`}
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
            {busy ? 'Following the flow…' : 'Place order'}
          </Button>
        </form>
        <section className="panel">
          <PanelHeading title="Order history" copy={`${orders.length} most recent`} />
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
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Status</th>
            <th>Total</th>
            <th>Placed</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => (
            <tr key={row.id}>
              <td>
                <code className="table-code">{short(row.id)}</code>
              </td>
              <td>
                <Badge status={row.status} />
              </td>
              <td>{row.total ? money(row.total.amount, row.total.currency) : 'Pending'}</td>
              <td>{dateOf(row.createdAt)}</td>
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
      {!orders.length ? <Empty copy="No orders yet. Place the first one from Orders." /> : null}
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
  const lines = order.confirmedLines.length ? order.confirmedLines : order.requestedLines
  return (
    <Dialog.Root>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <Eye aria-hidden="true" size={16} /> Details
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup order-detail-dialog">
          <div className="dialog-heading">
            <Dialog.Title>Order {short(order.id)}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              Created {dateTimeOf(order.createdAt)}.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <div className="order-detail-summary">
            <div>
              <span className="summary-label">Status</span>
              <Badge status={order.status} />
            </div>
            <div>
              <span className="summary-label">Customer</span>
              <strong>{customer?.name ?? short(order.customerId)}</strong>
            </div>
            <div>
              <span className="summary-label">Warehouse</span>
              <strong>{warehouse?.name ?? short(order.fulfillmentWarehouseId)}</strong>
            </div>
            <div>
              <span className="summary-label">Total</span>
              <strong>
                {order.total ? money(order.total.amount, order.total.currency) : 'Pending'}
              </strong>
            </div>
          </div>
          <div className="order-detail-lines">
            <h3>Lines</h3>
            {lines.map((line) => {
              const confirmed = isConfirmedOrderLine(line)
              return (
                <div key={line.lineId}>
                  <span>
                    <strong>{confirmed ? line.description : `Item ${short(line.itemId)}`}</strong>
                    <small className="detail-line-meta">Quantity {line.quantity}</small>
                  </span>
                  <strong>
                    {confirmed ? money(line.lineTotal.amount, line.lineTotal.currency) : 'Pending'}
                  </strong>
                </div>
              )
            })}
          </div>
          <div className="dialog-actions">
            <Dialog.Close className="ui-button ui-button-secondary">Close</Dialog.Close>
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
