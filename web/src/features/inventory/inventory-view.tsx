'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Buildings, Cube, Package, Plus, Prohibit, Warning, X } from '@phosphor-icons/react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import { minorUnits } from '@/lib/format'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

export type Warehouse = {
  id: string
  name: string
  active: boolean
  balances: Array<{ itemId: string; onHand: string; reserved: string }>
}

export function InventoryView({
  items,
  warehouses,
  onChanged,
  setNotice,
}: {
  items: CatalogItem[]
  warehouses: Warehouse[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [warehouseId, setWarehouseId] = useState('all')
  const [query, setQuery] = useState('')
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const rows = useMemo(() => {
    const aggregated = new Map<
      string,
      { itemId: string; warehouseNames: string[]; onHand: number; reserved: number }
    >()
    for (const warehouse of warehouses) {
      if (warehouseId !== 'all' && warehouse.id !== warehouseId) continue
      for (const balance of warehouse.balances) {
        const current = aggregated.get(balance.itemId) ?? {
          itemId: balance.itemId,
          warehouseNames: [],
          onHand: 0,
          reserved: 0,
        }
        current.warehouseNames.push(warehouse.name)
        current.onHand += Number(balance.onHand)
        current.reserved += Number(balance.reserved)
        aggregated.set(balance.itemId, current)
      }
    }
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return [...aggregated.values()].filter((row) => {
      const item = itemById.get(row.itemId)
      return (
        !normalizedQuery ||
        item?.name.toLocaleLowerCase().includes(normalizedQuery) ||
        item?.sku.toLocaleLowerCase().includes(normalizedQuery)
      )
    })
  }, [itemById, query, warehouseId, warehouses])
  const totals = rows.reduce(
    (result, row) => ({
      onHand: result.onHand + row.onHand,
      reserved: result.reserved + row.reserved,
    }),
    { onHand: 0, reserved: 0 },
  )

  return (
    <section>
      <header className="page-heading page-heading-with-actions">
        <div>
          <p className="eyebrow">Stock control</p>
          <h1>Inventory</h1>
          <p className="catalog-page-copy">
            Track physical stock, reservations and availability across warehouses.
          </p>
        </div>
        <div className="page-actions">
          <ReceiveStockDialog
            items={items}
            warehouses={warehouses}
            onChanged={onChanged}
            setNotice={setNotice}
          />
          <CreateWarehouseDialog onChanged={onChanged} setNotice={setNotice} />
        </div>
      </header>

      <div className="inventory-stats">
        <InventoryStat
          icon={<Buildings size={19} />}
          label="Warehouses"
          value={warehouses.length}
        />
        <InventoryStat icon={<Cube size={19} />} label="On hand" value={totals.onHand} />
        <InventoryStat icon={<Package size={19} />} label="Reserved" value={totals.reserved} />
        <InventoryStat
          icon={<Warning size={19} />}
          label="Unavailable items"
          value={rows.filter((row) => row.onHand - row.reserved <= 0).length}
          warning
        />
      </div>

      <div className="inventory-layout">
        <aside className="panel warehouse-list" aria-label="Warehouses">
          <header>
            <h2>Warehouses</h2>
            <span className="warehouse-count">
              {warehouses.filter((warehouse) => warehouse.active).length} active
            </span>
          </header>
          <Button
            className={warehouseId === 'all' ? 'warehouse-option active' : 'warehouse-option'}
            onClick={() => setWarehouseId('all')}
            type="button"
          >
            <span className="resource-icon">
              <Buildings aria-hidden="true" size={17} />
            </span>
            <span>
              <strong>All locations</strong>
              <small>Consolidated stock</small>
            </span>
          </Button>
          {warehouses.map((warehouse) => (
            <div className="warehouse-entry" key={warehouse.id}>
              <Button
                className={
                  warehouseId === warehouse.id ? 'warehouse-option active' : 'warehouse-option'
                }
                onClick={() => setWarehouseId(warehouse.id)}
                type="button"
              >
                <span className="resource-icon">
                  <Buildings aria-hidden="true" size={17} />
                </span>
                <span>
                  <strong>{warehouse.name}</strong>
                  <small>{warehouse.balances.length} stocked items</small>
                </span>
                <span className="warehouse-status">
                  <Badge status={warehouse.active ? 'active' : 'inactive'} />
                </span>
              </Button>
              {warehouse.active ? (
                <DeactivateWarehouseDialog
                  warehouse={warehouse}
                  onChanged={onChanged}
                  setNotice={setNotice}
                />
              ) : null}
            </div>
          ))}
        </aside>

        <section className="panel table-panel inventory-table-panel">
          <header className="inventory-table-heading">
            <div>
              <h2>Stock balances</h2>
              <p className="inventory-table-copy">
                {warehouseId === 'all'
                  ? 'All warehouse locations'
                  : warehouses.find((row) => row.id === warehouseId)?.name}
              </p>
            </div>
            <input
              aria-label="Search stock"
              className="ui-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search item or SKU…"
              type="search"
              value={query}
            />
          </header>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Location</th>
                  <th>On hand</th>
                  <th>Reserved</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const item = itemById.get(row.itemId)
                  return (
                    <tr key={row.itemId}>
                      <td>
                        <div className="resource-name">
                          <span className="resource-icon">
                            <Package aria-hidden="true" size={17} />
                          </span>
                          <span>
                            <strong>{item?.name ?? 'Unknown item'}</strong>
                            <small>{item?.sku ?? row.itemId}</small>
                          </span>
                        </div>
                      </td>
                      <td>{row.warehouseNames.join(', ')}</td>
                      <td>{quantity(row.onHand)}</td>
                      <td>{quantity(row.reserved)}</td>
                      <td>
                        <strong>{quantity(row.onHand - row.reserved)}</strong>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!rows.length ? (
            <div className="catalog-empty">
              <strong>No stock found</strong>
              <p>Adjust the location or item search.</p>
            </div>
          ) : null}
        </section>
      </div>
    </section>
  )
}

function CreateWarehouseDialog({ onChanged, setNotice }: MutationProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const response = await tracedFetch(
      'inventory.warehouse.create',
      '/api/horizon/inventory/warehouses',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: String(data.get('name') ?? '').trim() }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The warehouse could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setNotice('Warehouse created successfully.')
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} /> New warehouse
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <DialogHeading
            title="Create warehouse"
            description="Add a physical location for stock balances and reservations."
          />
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <TextField
              label="Warehouse name"
              maxLength={120}
              name="name"
              placeholder="Distribution center"
              required
            />
            <FormActions busy={busy} error={error} label="Create warehouse" />
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ReceiveStockDialog({
  items,
  warehouses,
  onChanged,
  setNotice,
}: {
  items: CatalogItem[]
  warehouses: Warehouse[]
} & MutationProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const unitCost = minorUnits(String(data.get('unitCost') ?? ''))
    if (!unitCost) {
      setError('Enter a valid non-negative unit cost with up to two decimal places.')
      setBusy(false)
      return
    }
    const response = await tracedFetch(
      'inventory.stock.receive',
      '/api/horizon/inventory/stock-receipts',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          warehouseId: data.get('warehouseId'),
          itemId: data.get('itemId'),
          quantity: data.get('quantity'),
          unitCost,
          currency: String(data.get('currency') ?? 'BRL').toUpperCase(),
        }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The stock receipt could not be posted.'))
      setBusy(false)
      return
    }
    form.reset()
    setNotice('Stock receipt posted successfully.')
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger
        className="ui-button ui-button-secondary"
        disabled={!items.length || !warehouses.some((warehouse) => warehouse.active)}
      >
        <Cube aria-hidden="true" size={17} /> Receive stock
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <DialogHeading
            title="Receive stock"
            description="Increase on-hand quantity and recalculate the weighted average cost."
          />
          <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <form className="dialog-form" onSubmit={submit}>
            <SelectField
              label="Warehouse"
              name="warehouseId"
              options={warehouses
                .filter((warehouse) => warehouse.active)
                .map((warehouse) => ({ label: warehouse.name, value: warehouse.id }))}
              required
            />
            <SelectField
              label="Item"
              name="itemId"
              options={items
                .filter((item) => item.active && item.kind === 'product')
                .map((item) => ({ label: `${item.name} · ${item.sku}`, value: item.id }))}
              required
            />
            <div className="form-grid two-columns">
              <TextField
                defaultValue="1"
                inputMode="decimal"
                label="Quantity"
                name="quantity"
                pattern="[0-9]+([.][0-9]{1,6})?"
                required
              />
              <TextField
                inputMode="decimal"
                label="Unit cost"
                name="unitCost"
                pattern="[0-9]+([.,][0-9]{1,2})?"
                placeholder="0.00"
                required
              />
            </div>
            <TextField
              defaultValue="BRL"
              label="Currency"
              maxLength={3}
              minLength={3}
              name="currency"
              pattern="[A-Za-z]{3}"
              required
            />
            <FormActions busy={busy} error={error} label="Post receipt" />
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DeactivateWarehouseDialog({
  warehouse,
  onChanged,
  setNotice,
}: { warehouse: Warehouse } & MutationProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function deactivate() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'inventory.warehouse.deactivate',
      `/api/horizon/inventory/warehouses/${warehouse.id}/deactivate`,
      { method: 'PATCH' },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The warehouse could not be deactivated.'))
      setBusy(false)
      return
    }
    setNotice(`${warehouse.name} was deactivated.`)
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger
        aria-label={`Deactivate ${warehouse.name}`}
        className="ui-button ui-button-ghost warehouse-deactivate"
      >
        <Prohibit aria-hidden="true" size={14} />
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Deactivate {warehouse.name}?</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              The location remains in historical records but cannot receive stock or fulfill new
              orders.
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">Cancel</AlertDialog.Close>
            <Button disabled={busy} onClick={deactivate} type="button" variant="danger">
              {busy ? 'Deactivating…' : 'Deactivate warehouse'}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

type MutationProps = { onChanged: () => Promise<void>; setNotice: (value: string) => void }

function DialogHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="dialog-heading">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description className="dialog-description">{description}</Dialog.Description>
    </div>
  )
}

function FormActions({ busy, error, label }: { busy: boolean; error: string; label: string }) {
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Dialog.Close className="ui-button ui-button-secondary">Cancel</Dialog.Close>
        <Button disabled={busy} type="submit" variant="primary">
          {busy ? 'Saving…' : label}
        </Button>
      </div>
    </>
  )
}

async function apiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown }
    const value = body.detail ?? body.message
    if (typeof value === 'string') return value
  } catch {}
  return fallback
}

function InventoryStat({
  icon,
  label,
  value,
  warning = false,
}: {
  icon: ReactNode
  label: string
  value: number
  warning?: boolean
}) {
  return (
    <article className={warning ? 'inventory-stat warning' : 'inventory-stat'}>
      <span className="resource-icon">{icon}</span>
      <span>{label}</span>
      <strong>{quantity(value)}</strong>
    </article>
  )
}

function quantity(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
}
