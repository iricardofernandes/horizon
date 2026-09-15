'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { CurrencyCircleDollar, Package, Plus, Prohibit, Ruler, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { minorUnits } from '@/lib/format'
import { jsonHeaders } from '@/lib/http'
import { useStatusLabel } from '@/lib/status'
import { tracedFetch } from '@/lib/telemetry'
import { useMoney, useQuantity } from '@/lib/use-format'

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
  const t = useTranslations('catalog')
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
            <span className="read-only-badge">{t('viewOnly')}</span>
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
          <Tabs.List aria-label={t('sections')} className="ui-tabs-list">
            <Tabs.Tab className="ui-tab" value="items">
              {t('item')} <span className="tab-count">{items.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="units">
              {t('units')} <span className="tab-count">{units.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="prices">
              {t('prices')} <span className="tab-count">{priceLists.length}</span>
            </Tabs.Tab>
          </Tabs.List>
          <label className="catalog-search">
            <span className="sr-only">{t('search')}</span>
            <input
              aria-label={t('search')}
              className="ui-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder(t, section)}
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
  const t = useTranslations('catalog')
  return (
    <header className="page-heading page-heading-with-actions">
      <div>
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p className="catalog-page-copy">{t('copy')}</p>
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
  const t = useTranslations('catalog')
  const common = useTranslations('common')
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
              <th>{t('item')}</th>
              <th>{t('sku')}</th>
              <th>{t('type')}</th>
              <th>{t('unit')}</th>
              <th>{t('price')}</th>
              <th>{t('available')}</th>
              <th>{t('status')}</th>
              {!readOnly ? <th aria-label={common('actions')} /> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ItemRow
                availability={availabilityByItem.get(item.id) ?? 0}
                item={item}
                key={item.id}
                onChanged={onChanged}
                price={priceByItem.get(item.id)}
                priceLists={priceLists}
                readOnly={readOnly}
                setNotice={setNotice}
                unit={item.unitId ? unitById.get(item.unitId) : undefined}
              />
            ))}
          </tbody>
        </table>
      </div>
      {!items.length ? <EmptyState title={t('emptyItems')} copy={t('emptyItemsCopy')} /> : null}
    </div>
  )
}

type ItemPrice = { itemId: string; amount: string; currency: string }

function ItemRow({
  item,
  unit,
  price,
  availability,
  priceLists,
  readOnly,
  onChanged,
  setNotice,
}: {
  item: CatalogItem
  unit: CatalogUnit | undefined
  price: ItemPrice | undefined
  availability: number
  priceLists: CatalogPriceList[]
  readOnly: boolean
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const t = useTranslations('catalog')
  const common = useTranslations('common')
  const statusLabel = useStatusLabel()
  const money = useMoney()
  const quantity = useQuantity()
  const status = item.active ? 'active' : 'inactive'
  return (
    <tr>
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
      <td>{item.kind === 'service' ? t('kindService') : t('kindProduct')}</td>
      <td>{unit?.code ?? '—'}</td>
      <td>{price ? money(price.amount, price.currency) : common('notSet')}</td>
      <td>{quantity(availability)}</td>
      <td>
        <Badge status={status} label={statusLabel(status)} />
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
              <DeactivateItemDialog item={item} onChanged={onChanged} setNotice={setNotice} />
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  )
}

function UnitsTable({ units }: { units: CatalogUnit[] }) {
  const t = useTranslations('catalog')
  const statusLabel = useStatusLabel()
  return (
    <div className="panel table-panel catalog-table-panel">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('unit')}</th>
              <th>{t('code')}</th>
              <th>{t('decimalPlaces')}</th>
              <th>{t('status')}</th>
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
                  <Badge
                    status={unit.active ? 'active' : 'inactive'}
                    label={statusLabel(unit.active ? 'active' : 'inactive')}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!units.length ? <EmptyState title={t('emptyUnits')} copy={t('emptyUnitsCopy')} /> : null}
    </div>
  )
}

function PriceListsTable({ lists, items }: { lists: CatalogPriceList[]; items: CatalogItem[] }) {
  const t = useTranslations('catalog')
  const statusLabel = useStatusLabel()
  const money = useMoney()
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
                {list.currency} · {t('pricedItems', { count: list.prices.length })}
              </p>
            </div>
            <Badge
              status={list.active ? 'active' : 'inactive'}
              label={statusLabel(list.active ? 'active' : 'inactive')}
            />
          </header>
          <div className="price-list-rows">
            {list.prices.slice(0, 6).map((price) => (
              <div key={price.itemId}>
                <span>{itemById.get(price.itemId)?.name ?? t('unknownItem')}</span>
                <strong>{money(price.amount, list.currency)}</strong>
              </div>
            ))}
            {!list.prices.length ? <p className="empty compact-empty">{t('noPrices')}</p> : null}
          </div>
        </article>
      ))}
      {!lists.length ? (
        <EmptyState title={t('emptyPriceLists')} copy={t('emptyPriceListsCopy')} />
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
  const t = useTranslations('catalog')
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
      setError(await apiError(response, t('createItemFailed')))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice(t('itemCreated'))
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary" disabled={!units.length}>
        <Plus aria-hidden="true" size={17} weight="bold" />
        {t('createItem')}
      </Dialog.Trigger>
      <DialogSurface description={t('createItemDescription')} title={t('createItemTitle')}>
        <form className="dialog-form" onSubmit={submit}>
          <div className="form-grid two-columns">
            <SelectField
              label={t('type')}
              name="kind"
              options={[
                { label: t('kindProduct'), value: 'product' },
                { label: t('kindService'), value: 'service' },
              ]}
              required
            />
            <TextField label={t('sku')} maxLength={64} name="sku" placeholder="SKU-001" required />
          </div>
          <TextField
            label={t('name')}
            maxLength={160}
            name="name"
            placeholder={t('namePlaceholder')}
            required
          />
          <SelectField
            label={t('unitOfMeasure')}
            name="unitId"
            options={units
              .filter((unit) => unit.active)
              .map((unit) => ({ label: `${unit.name} (${unit.code})`, value: unit.id }))}
            required
          />
          <TextField
            description={t('ncmHelp')}
            label="NCM"
            name="ncm"
            pattern="[0-9. ]{8,16}"
            placeholder="0901.21.00"
          />
          <DialogActions busy={busy} error={error} submitLabel={t('createItemSubmit')} />
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
  const t = useTranslations('catalog')
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
      setError(await apiError(response, t('createUnitFailed')))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice(t('unitCreated'))
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        {t('createUnit')}
      </Dialog.Trigger>
      <DialogSurface description={t('createUnitDescription')} title={t('createUnitTitle')}>
        <form className="dialog-form" onSubmit={submit}>
          <div className="form-grid two-columns">
            <TextField label={t('code')} maxLength={6} name="code" placeholder="UN" required />
            <TextField
              defaultValue="0"
              label={t('decimalPlaces')}
              max="6"
              min="0"
              name="decimalPlaces"
              required
              type="number"
            />
          </div>
          <TextField
            label={t('name')}
            maxLength={160}
            name="name"
            placeholder={t('unitNamePlaceholder')}
            required
          />
          <DialogActions busy={busy} error={error} submitLabel={t('createUnitSubmit')} />
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
  const t = useTranslations('catalog')
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
      setError(await apiError(response, t('createPriceListFailed')))
      setBusy(false)
      return
    }
    form.reset()
    setOpen(false)
    setNotice(t('priceListCreated'))
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-primary">
        <Plus aria-hidden="true" size={17} weight="bold" />
        {t('createPriceList')}
      </Dialog.Trigger>
      <DialogSurface
        description={t('createPriceListDescription')}
        title={t('createPriceListTitle')}
      >
        <form className="dialog-form" onSubmit={submit}>
          <TextField
            label={t('name')}
            maxLength={160}
            name="name"
            placeholder={t('priceListNamePlaceholder')}
            required
          />
          <TextField
            defaultValue="BRL"
            description={t('currencyHelp')}
            label={t('currency')}
            maxLength={3}
            minLength={3}
            name="currency"
            pattern="[A-Za-z]{3}"
            required
          />
          <DialogActions busy={busy} error={error} submitLabel={t('createPriceListSubmit')} />
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
  const t = useTranslations('catalog')
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
      setError(t('selectPriceList'))
      setBusy(false)
      return
    }
    const amount = minorUnits(String(data.get('amount') ?? ''))
    if (!amount) {
      setError(t('amountInvalid'))
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
      setError(await apiError(response, t('priceFailed')))
      setBusy(false)
      return
    }
    setOpen(false)
    setNotice(t('priceUpdated', { name: item.name }))
    await onChanged()
    setBusy(false)
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <CurrencyCircleDollar aria-hidden="true" size={16} />
        {t('setPrice')}
      </Dialog.Trigger>
      <DialogSurface
        description={t('setPriceDescription', { name: item.name })}
        title={t('setPriceTitle')}
      >
        <form className="dialog-form" onSubmit={submit}>
          <SelectField
            label={t('priceList')}
            name="priceListId"
            options={priceLists
              .filter((list) => list.active)
              .map((list) => ({ label: `${list.name} (${list.currency})`, value: list.id }))}
            required
          />
          <TextField
            description={t('amountHelp')}
            inputMode="decimal"
            label={t('amount')}
            name="amount"
            pattern="[0-9]+([.,][0-9]{1,2})?"
            placeholder="0.00"
            required
          />
          <DialogActions busy={busy} error={error} submitLabel={t('setPriceSubmit')} />
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
  const t = useTranslations('catalog')
  const common = useTranslations('common')
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
      setError(await apiError(response, t('deactivateFailed')))
      setBusy(false)
      return
    }
    setNotice(t('deactivated', { name: item.name }))
    await onChanged()
    setOpen(false)
    setBusy(false)
  }

  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger className="ui-button ui-button-ghost row-action-button danger-action">
        <Prohibit aria-hidden="true" size={16} />
        {t('deactivate')}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>{t('deactivateTitle', { name: item.name })}</AlertDialog.Title>
            <AlertDialog.Description>{t('deactivateWarning')}</AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">
              {common('cancel')}
            </AlertDialog.Close>
            <Button disabled={busy} onClick={deactivate} type="button" variant="danger">
              {busy ? t('deactivating') : t('deactivateItemSubmit')}
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
  const common = useTranslations('common')
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="ui-dialog-backdrop" />
      <Dialog.Popup className="ui-dialog-popup">
        <div className="dialog-heading">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
        </div>
        <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
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
  const t = useTranslations('catalog')
  const common = useTranslations('common')
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Dialog.Close className="ui-button ui-button-secondary">{common('cancel')}</Dialog.Close>
        <Button disabled={busy} type="submit" variant="primary">
          {busy ? t('saving') : submitLabel}
        </Button>
      </div>
    </>
  )
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="catalog-empty">
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  )
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

function searchPlaceholder(
  t: (key: 'searchItems' | 'searchUnits' | 'searchPriceLists') => string,
  section: CatalogSection,
): string {
  if (section === 'units') return t('searchUnits')
  if (section === 'prices') return t('searchPriceLists')
  return t('searchItems')
}
