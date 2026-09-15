'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { CurrencyCircleDollar, Package, Plus, Prohibit, Ruler, X } from '@phosphor-icons/react'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'

export type CatalogItem = {
  id: string
  sku: string
  name: string
  kind: 'product' | 'service'
  unitId?: string
  ncm?: string | null
  active: boolean
}

export type CatalogUnit = {
  id: string
  code: string
  name: string
  decimalPlaces: number
  active: boolean
}

export type CatalogPriceList = {
  id: string
  name: string
  prices: Array<{ itemId: string; amount: string }>
  currency: string
  active: boolean
}

type Warehouse = {
  balances: Array<{ itemId: string; onHand: string; reserved: string }>
}

type CatalogViewProps = {
  items: CatalogItem[]
  units: CatalogUnit[]
  priceLists: CatalogPriceList[]
  warehouses: Warehouse[]
  readOnly: boolean
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}

type CatalogSection = 'items' | 'units' | 'prices'

export function CatalogView({
  items,
  units,
  priceLists,
  warehouses,
  readOnly,
  onChanged,
  setNotice,
}: CatalogViewProps) {
  const [section, setSection] = useState<CatalogSection>('items')
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredItems = items.filter(
    (item) =>
      !normalizedQuery ||
      item.name.toLocaleLowerCase().includes(normalizedQuery) ||
      item.sku.toLocaleLowerCase().includes(normalizedQuery),
  )
  const filteredUnits = units.filter(
    (unit) =>
      !normalizedQuery ||
      unit.name.toLocaleLowerCase().includes(normalizedQuery) ||
      unit.code.toLocaleLowerCase().includes(normalizedQuery),
  )
  const filteredPriceLists = priceLists.filter(
    (list) => !normalizedQuery || list.name.toLocaleLowerCase().includes(normalizedQuery),
  )

  return (
    <section>
      <PageHeader
        actions={
          readOnly ? (
            <span className="read-only-badge">View only</span>
          ) : section === 'items' ? (
            <CreateItemDialog units={units} onChanged={onChanged} setNotice={setNotice} />
          ) : section === 'units' ? (
            <CreateUnitDialog onChanged={onChanged} setNotice={setNotice} />
          ) : (
            <CreatePriceListDialog onChanged={onChanged} setNotice={setNotice} />
          )
        }
      />

      <Tabs.Root
        className="catalog-tabs"
        onValueChange={(value) => {
          setSection(value as CatalogSection)
          setQuery('')
        }}
        value={section}
      >
        <div className="catalog-toolbar">
          <Tabs.List aria-label="Catalog sections" className="ui-tabs-list">
            <Tabs.Tab className="ui-tab" value="items">
              Items <span className="tab-count">{items.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="units">
              Units <span className="tab-count">{units.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="prices">
              Price lists <span className="tab-count">{priceLists.length}</span>
            </Tabs.Tab>
          </Tabs.List>
          <label className="catalog-search">
            <span className="sr-only">Search catalog</span>
            <input
              aria-label="Search catalog"
              className="ui-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${section === 'prices' ? 'price lists' : section}…`}
              type="search"
              value={query}
            />
          </label>
        </div>

        <Tabs.Panel className="ui-tab-panel" value="items">
          <ItemsTable
            items={filteredItems}
            priceLists={priceLists}
            units={units}
            warehouses={warehouses}
            readOnly={readOnly}
            onChanged={onChanged}
            setNotice={setNotice}
          />
        </Tabs.Panel>
        <Tabs.Panel className="ui-tab-panel" value="units">
          <UnitsTable units={filteredUnits} />
        </Tabs.Panel>
        <Tabs.Panel className="ui-tab-panel" value="prices">
          <PriceListsTable lists={filteredPriceLists} items={items} />
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  )
}

function PageHeader({ actions }: { actions: ReactNode }) {
  return (
    <header className="page-heading page-heading-with-actions">
      <div>
        <p className="eyebrow">Commercial foundation</p>
        <h1>Catalog</h1>
        <p className="catalog-page-copy">
          Manage items, units of measure and the prices used by Sales.
        </p>
      </div>
      <div className="page-actions">{actions}</div>
    </header>
  )
}

function ItemsTable({
  items,
  units,
  priceLists,
  warehouses,
  readOnly,
  onChanged,
  setNotice,
}: {
  items: CatalogItem[]
  units: CatalogUnit[]
  priceLists: CatalogPriceList[]
  warehouses: Warehouse[]
  readOnly: boolean
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units])
  const priceByItem = useMemo(
    () =>
      new Map(
        priceLists.flatMap((list) =>
          list.prices.map((price) => [price.itemId, { ...price, currency: list.currency }]),
        ),
      ),
    [priceLists],
  )
  const availabilityByItem = useMemo(() => {
    const result = new Map<string, number>()
    for (const balance of warehouses.flatMap((warehouse) => warehouse.balances)) {
      const available = Number(balance.onHand) - Number(balance.reserved)
      result.set(balance.itemId, (result.get(balance.itemId) ?? 0) + available)
    }
    return result
  }, [warehouses])

  return (
    <div className="panel table-panel catalog-table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>SKU</th>
              <th>Type</th>
              <th>Unit</th>
              <th>Price</th>
              <th>Available</th>
              <th>Status</th>
              {!readOnly ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const price = priceByItem.get(item.id)
              const unit = item.unitId ? unitById.get(item.unitId) : undefined
              return (
                <tr key={item.id}>
                  <td>
                    <div className="resource-name">
                      <span className="resource-icon" aria-hidden="true">
                        <Package size={17} />
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        {item.ncm ? <small>NCM {item.ncm}</small> : null}
                      </span>
                    </div>
                  </td>
                  <td>
                    <code className="table-code">{item.sku}</code>
                  </td>
                  <td className="capitalize">{item.kind}</td>
                  <td>{unit?.code ?? '—'}</td>
                  <td>{price ? money(price.amount, price.currency) : 'Not set'}</td>
                  <td>{formatQuantity(availabilityByItem.get(item.id) ?? 0)}</td>
                  <td>
                    <StatusBadge status={item.active ? 'active' : 'inactive'} />
                  </td>
                  {!readOnly ? (
                    <td>
                      <div className="row-actions">
                        <SetPriceDialog
                          item={item}
                          priceLists={priceLists}
                          onChanged={onChanged}
                          setNotice={setNotice}
                        />
                        {item.active ? (
                          <DeactivateItemDialog
                            item={item}
                            onChanged={onChanged}
                            setNotice={setNotice}
                          />
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!items.length ? (
        <EmptyState title="No items found" copy="Create an item or adjust your search." />
      ) : null}
    </div>
  )
}

function UnitsTable({ units }: { units: CatalogUnit[] }) {
  return (
    <div className="panel table-panel catalog-table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Code</th>
              <th>Decimal places</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {units.map((unit) => (
              <tr key={unit.id}>
                <td>
                  <div className="resource-name">
                    <span className="resource-icon" aria-hidden="true">
                      <Ruler size={17} />
                    </span>
                    <strong>{unit.name}</strong>
                  </div>
                </td>
                <td>
                  <code className="table-code">{unit.code}</code>
                </td>
                <td>{unit.decimalPlaces}</td>
                <td>
                  <StatusBadge status={unit.active ? 'active' : 'inactive'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!units.length ? (
        <EmptyState title="No units found" copy="Create a unit of measure to classify items." />
      ) : null}
    </div>
  )
}

function PriceListsTable({ lists, items }: { lists: CatalogPriceList[]; items: CatalogItem[] }) {
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  return (
    <div className="price-list-grid">
      {lists.map((list) => (
        <article className="panel price-list-card" key={list.id}>
          <header>
            <span className="resource-icon" aria-hidden="true">
              <CurrencyCircleDollar size={18} />
            </span>
            <div>
              <h2>{list.name}</h2>
              <p className="price-list-summary">
                {list.currency} · {list.prices.length} priced items
              </p>
            </div>
            <StatusBadge status={list.active ? 'active' : 'inactive'} />
          </header>
          <div className="price-list-rows">
            {list.prices.slice(0, 6).map((price) => (
              <div key={price.itemId}>
                <span>{itemById.get(price.itemId)?.name ?? 'Unknown item'}</span>
                <strong>{money(price.amount, list.currency)}</strong>
              </div>
            ))}
            {!list.prices.length ? <p className="empty compact-empty">No prices set yet.</p> : null}
          </div>
        </article>
      ))}
      {!lists.length ? (
        <EmptyState
          title="No price lists found"
          copy="Create the first price list for this workspace."
        />
      ) : null}
    </div>
  )
}

function CreateItemDialog({
  units,
  onChanged,
  setNotice,
}: {
  units: CatalogUnit[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const ncm = String(data.get('ncm') ?? '').trim()
    const response = await tracedFetch('catalog.item.create', '/api/horizon/catalog/items', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        kind: data.get('kind'),
        sku: String(data.get('sku') ?? '').trim(),
        name: String(data.get('name') ?? '').trim(),
        unitId: data.get('unitId'),
        ...(ncm ? { ncm } : {}),
      }),
    })
    if (!response.ok) {
      setError(await apiError(response, 'The item could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice('Item created successfully.')
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary" disabled={!units.length}>
        <Plus aria-hidden="true" size={17} weight="bold" />
        New item
      </Dialog.Trigger>
      <DialogSurface description="Add a product or service to this workspace." title="Create item">
        <form className="dialog-form" onSubmit={submit}>
          <div className="form-grid two-columns">
            <SelectField
              label="Type"
              name="kind"
              options={[
                { label: 'Product', value: 'product' },
                { label: 'Service', value: 'service' },
              ]}
              required
            />
            <TextField label="SKU" maxLength={64} name="sku" placeholder="SKU-001" required />
          </div>
          <TextField label="Name" maxLength={160} name="name" placeholder="Item name" required />
          <SelectField
            label="Unit of measure"
            name="unitId"
            options={units
              .filter((unit) => unit.active)
              .map((unit) => ({ label: `${unit.name} (${unit.code})`, value: unit.id }))}
            required
          />
          <TextField
            description="Optional Brazilian fiscal classification, with exactly eight digits."
            label="NCM"
            name="ncm"
            pattern="[0-9. ]{8,16}"
            placeholder="0901.21.00"
          />
          <DialogActions busy={busy} error={error} submitLabel="Create item" />
        </form>
      </DialogSurface>
    </Dialog.Root>
  )
}

function CreateUnitDialog({
  onChanged,
  setNotice,
}: {
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    const response = await tracedFetch('catalog.unit.create', '/api/horizon/catalog/units', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        code: String(data.get('code') ?? '')
          .trim()
          .toUpperCase(),
        name: String(data.get('name') ?? '').trim(),
        decimalPlaces: Number(data.get('decimalPlaces')),
      }),
    })
    if (!response.ok) {
      setError(await apiError(response, 'The unit could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice('Unit of measure created successfully.')
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        New unit
      </Dialog.Trigger>
      <DialogSurface
        description="Define how quantities are recorded for catalog items."
        title="Create unit"
      >
        <form className="dialog-form" onSubmit={submit}>
          <div className="form-grid two-columns">
            <TextField label="Code" maxLength={6} name="code" placeholder="UN" required />
            <TextField
              defaultValue="0"
              label="Decimal places"
              max="6"
              min="0"
              name="decimalPlaces"
              required
              type="number"
            />
          </div>
          <TextField label="Name" maxLength={160} name="name" placeholder="Unit" required />
          <DialogActions busy={busy} error={error} submitLabel="Create unit" />
        </form>
      </DialogSurface>
    </Dialog.Root>
  )
}

function CreatePriceListDialog({
  onChanged,
  setNotice,
}: {
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
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
      'catalog.price-list.create',
      '/api/horizon/catalog/price-lists',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          name: String(data.get('name') ?? '').trim(),
          currency: String(data.get('currency') ?? '')
            .trim()
            .toUpperCase(),
        }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The price list could not be created.'))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice('Price list created successfully.')
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        New price list
      </Dialog.Trigger>
      <DialogSurface
        description="Create a commercial price context for this workspace."
        title="Create price list"
      >
        <form className="dialog-form" onSubmit={submit}>
          <TextField label="Name" maxLength={160} name="name" placeholder="Retail" required />
          <TextField
            defaultValue="BRL"
            description="ISO 4217 three-letter currency code."
            label="Currency"
            maxLength={3}
            minLength={3}
            name="currency"
            pattern="[A-Za-z]{3}"
            required
          />
          <DialogActions busy={busy} error={error} submitLabel="Create price list" />
        </form>
      </DialogSurface>
    </Dialog.Root>
  )
}

function SetPriceDialog({
  item,
  priceLists,
  onChanged,
  setNotice,
}: {
  item: CatalogItem
  priceLists: CatalogPriceList[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const list = priceLists.find((candidate) => candidate.id === data.get('priceListId'))
    if (!list) {
      setError('Select a price list.')
      setBusy(false)
      return
    }
    const amount = minorUnits(String(data.get('amount') ?? ''))
    if (!amount) {
      setError('Enter a valid non-negative amount with up to two decimal places.')
      setBusy(false)
      return
    }
    const response = await tracedFetch(
      'catalog.price.set',
      `/api/horizon/catalog/price-lists/${list.id}/prices/${item.id}`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ amount, currency: list.currency }),
      },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The price could not be saved.'))
      setBusy(false)
      return
    }
    setOpen(false)
    setNotice(`Price for ${item.name} updated successfully.`)
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <CurrencyCircleDollar aria-hidden="true" size={16} />
        Price
      </Dialog.Trigger>
      <DialogSurface description={`Set a price for ${item.name}.`} title="Set item price">
        <form className="dialog-form" onSubmit={submit}>
          <SelectField
            label="Price list"
            name="priceListId"
            options={priceLists
              .filter((list) => list.active)
              .map((list) => ({ label: `${list.name} (${list.currency})`, value: list.id }))}
            required
          />
          <TextField
            description="Use the major currency amount, for example 149.90."
            inputMode="decimal"
            label="Amount"
            name="amount"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            placeholder="0.00"
            required
          />
          <DialogActions busy={busy} error={error} submitLabel="Save price" />
        </form>
      </DialogSurface>
    </Dialog.Root>
  )
}

function DeactivateItemDialog({
  item,
  onChanged,
  setNotice,
}: {
  item: CatalogItem
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function deactivate() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'catalog.item.deactivate',
      `/api/horizon/catalog/items/${item.id}/deactivate`,
      { method: 'PATCH' },
    )
    if (!response.ok) {
      setError(await apiError(response, 'The item could not be deactivated.'))
      setBusy(false)
      return
    }
    setNotice(`${item.name} was deactivated.`)
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger className="ui-button ui-button-ghost row-action-button danger-action">
        <Prohibit aria-hidden="true" size={16} />
        Deactivate
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Deactivate {item.name}?</AlertDialog.Title>
            <AlertDialog.Description>
              Existing documents keep their reference, but this item can no longer be used in new
              operations.
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
              {busy ? 'Deactivating…' : 'Deactivate item'}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

function DialogSurface({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="ui-dialog-backdrop" />
      <Dialog.Popup className="ui-dialog-popup">
        <div className="dialog-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
        </div>
        <Dialog.Close aria-label="Close dialog" className="ui-dialog-close">
          <X aria-hidden="true" size={18} weight="bold" />
        </Dialog.Close>
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  )
}

function DialogActions({
  busy,
  error,
  submitLabel,
}: {
  busy: boolean
  error: string
  submitLabel: string
}) {
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
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status.replace('-', ' ')}</span>
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="catalog-empty">
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  )
}

function jsonHeaders() {
  return { 'content-type': 'application/json' }
}

async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown; title?: unknown }
    const message = body.detail ?? body.message ?? body.title
    if (Array.isArray(message)) return message.join(' ')
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    // The fallback below is intentionally used for empty and non-JSON upstream errors.
  }
  return fallback
}

function minorUnits(value: string): string | null {
  const normalized = value.trim().replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match?.[1]) return null
  const decimal = (match[2] ?? '').padEnd(2, '0')
  return `${match[1]}${decimal}`.replace(/^0+(?=\d)/, '')
}

function money(amount: string, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    Number(amount) / 100,
  )
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value)
}
