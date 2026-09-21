'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactNode, useState } from 'react'
import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { Resource } from '@/components/ui/resource'
import { apiError, readJson, readPage } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useMoney, useQuantity } from '@/lib/use-format'
import { useLoader } from '@/lib/use-loader'

export const INVENTORY = '/api/horizon/inventory'
export const CATALOG = '/api/horizon/catalog'
export type Item = { id: string; sku: string; name: string; kind: string }
export type Warehouse = { id: string; name: string; active: boolean }
export type Money = { amount: string; currency: string } | null
export type Common = { items: Item[]; warehouses: Warehouse[] }
export const list = <T,>(path: string) =>
  readJson<T[]>(`inventory.${path}`, `${INVENTORY}/${path}?limit=200`)
export const catalogPage = <T,>(path: string) =>
  readPage<T>(`catalog.${path}`, `${CATALOG}/${path}?limit=200`)
export async function common(): Promise<Common> {
  const [items, warehouses] = await Promise.all([
    catalogPage<Item>('items'),
    readJson<Warehouse[]>('inventory.warehouses', `${INVENTORY}/warehouses`),
  ])
  return { items, warehouses }
}

export function useAbilities() {
  const session = useSession()
  const roles =
    session?.roles.filter((role) => role.module === 'inventory').map((role) => role.role) ?? []
  return {
    manage: roles.includes('admin') || roles.includes('operator'),
    approve: roles.includes('admin'),
  }
}

export function Screen<T>({
  load,
  title,
  description,
  children,
}: {
  load: () => Promise<T>
  title: string
  description: string
  children: (data: T, reload: () => Promise<void>) => ReactNode
}) {
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => (
        <section>
          <header className="page-heading">
            <p className="eyebrow">{title}</p>
            <h1>{title}</h1>
            <p className="catalog-page-copy">{description}</p>
          </header>
          {children(data, state.reload)}
        </section>
      )}
    </Resource>
  )
}

export function useInventoryAction(reload: () => Promise<void>) {
  const t = useTranslations('inventoryPhase')
  const notice = useNotice()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(
    path: string,
    method: 'POST' | 'PUT' | 'PATCH',
    body?: unknown,
    catalog = false,
  ) {
    setBusy(true)
    setError('')
    try {
      const response = await tracedFetch(
        `inventory.${path}`,
        `${catalog ? CATALOG : INVENTORY}/${path}`,
        {
          method,
          headers: method === 'POST' ? idempotentJsonHeaders() : jsonHeaders(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      )
      if (!response.ok) {
        setError(await apiError(response, t('failed')))
        return false
      }
      await reload()
      notice(t('saved'))
      return true
    } catch {
      setError(t('failed'))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { run, busy, error, clear: () => setError('') }
}

export function Editor({
  title,
  action,
  children,
  busy,
  error,
  onSubmit,
}: {
  title: string
  action: string
  children: ReactNode
  busy: boolean
  error: string
  onSubmit: (form: HTMLFormElement) => Promise<void>
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onSubmit(event.currentTarget)
  }
  return (
    <form className="panel inventory-phase-form" onSubmit={submit}>
      <h2>{title}</h2>
      <div className="inventory-phase-fields">{children}</div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button disabled={busy} type="submit" variant="primary">
        {action}
      </Button>
    </form>
  )
}

export function Field({
  label,
  name,
  type = 'text',
  required = true,
  defaultValue,
  min,
  step,
  placeholder,
}: {
  label: string
  name: string
  type?: string
  required?: boolean
  defaultValue?: string
  min?: string
  step?: string
  placeholder?: string
}) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      <input
        className="ui-input"
        defaultValue={defaultValue}
        min={min}
        name={name}
        placeholder={placeholder}
        required={required}
        step={step}
        type={type}
      />
    </label>
  )
}

export function Choose({
  label,
  name,
  options,
  required = true,
  onChange,
  value,
}: {
  label: string
  name: string
  options: { value: string; label: string }[]
  required?: boolean
  onChange?: (value: string) => void
  value?: string
}) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}</span>
      <select
        className="ui-input"
        name={name}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        required={required}
        value={value}
      >
        {!required && <option value="">—</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[]
  rows: ReactNode[][]
  empty: string
}) {
  return (
    <div className="panel table-panel inventory-phase-table">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row
                  .map((cell) =>
                    typeof cell === 'string' || typeof cell === 'number' ? String(cell) : '',
                  )
                  .join('|')}
              >
                {row.map((cell, i) => (
                  <td key={columns[i]}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="catalog-empty">{empty}</p>}
    </div>
  )
}

export function useNames(data: Common) {
  const item = (id: string) => data.items.find((row) => row.id === id)?.name ?? id
  const warehouse = (id: string | null) =>
    data.warehouses.find((row) => row.id === id)?.name ?? id ?? '—'
  const itemOptions = data.items
    .filter((row) => row.kind === 'product')
    .map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` }))
  const warehouseOptions = data.warehouses
    .filter((row) => row.active)
    .map((row) => ({ value: row.id, label: row.name }))
  return { item, warehouse, itemOptions, warehouseOptions }
}

export function useDisplay() {
  const quantity = useQuantity()
  const money = useMoney()
  const date = useDate()
  return {
    quantity,
    date,
    money: (value: Money) => (value ? money(value.amount, value.currency) : '—'),
    minor: (amount: string | null, currency: string | null) =>
      amount && currency ? money(amount, currency) : '—',
  }
}

export function dataOf(form: HTMLFormElement) {
  return new FormData(form)
}
export function value(data: FormData, key: string) {
  return String(data.get(key) ?? '').trim()
}
export function optional(value: string) {
  return value || undefined
}

export function trackedPicks(data: FormData) {
  const lot = value(data, 'lot')
  const serials = value(data, 'serials')
    .split(',')
    .map((serial) => serial.trim())
    .filter(Boolean)
  return {
    ...(lot ? { lots: [{ code: lot, quantity: value(data, 'quantity') }] } : {}),
    ...(serials.length ? { serials } : {}),
  }
}
