'use client'

import { useSession } from '@/components/shell/workspace-context'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Customer } from '@/features/sales/customers-view'
import { apiError, readJson, readPage } from '@/lib/api'
import { idempotentJsonHeaders, jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'
import { type Contract, SALES_API, type ServiceOrder } from './types'

export type ServicesData = {
  orders: ServiceOrder[]
  contracts: Contract[]
  customers: Customer[]
  /** Catalog services a person may sell: active items of kind `service`. */
  services: CatalogItem[]
}

/** Every service screen reads the same documents, so the boards never disagree. */
export async function loadServices(): Promise<ServicesData> {
  const [orders, contracts, customers, items] = await Promise.all([
    readJson<ServiceOrder[]>('sales.service-orders', `${SALES_API}/service-orders`),
    readJson<Contract[]>('sales.contracts', `${SALES_API}/contracts`),
    readJson<Customer[]>('sales.customers', `${SALES_API}/customers`),
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100'),
  ])
  return {
    orders,
    contracts,
    customers,
    services: items.filter((item) => item.kind === 'service' && item.active),
  }
}

/** What the session may attempt; Sales still decides every command (ADR 0023, ADR 0045). */
export function useServiceAbilities(): { canWrite: boolean } {
  const session = useSession()
  const roles = (session?.roles ?? [])
    .filter((assignment) => assignment.module === 'sales')
    .map((assignment) => assignment.role)
  return { canWrite: roles.includes('admin') || roles.includes('representative') }
}

/** A customer's name where the registry knows one. */
export function nameOf(customers: readonly Customer[], customerId: string): string {
  return customers.find((customer) => customer.id === customerId)?.name ?? customerId.slice(0, 8)
}

export type CommandResult<T> = { ok: true; body: T } | { ok: false; error: string }

/**
 * One Sales command. Commands that create something carry an idempotency key; `key` lets
 * a caller retry under the same one (ADR 0028).
 */
export async function command<T = unknown>(
  name: string,
  path: string,
  options: { body?: unknown; idempotent?: boolean; key?: string; fallback: string },
): Promise<CommandResult<T>> {
  const headers =
    options.key !== undefined
      ? { ...jsonHeaders(), 'idempotency-key': options.key }
      : options.idempotent
        ? idempotentJsonHeaders()
        : jsonHeaders()
  const response = await tracedFetch(name, path, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  })
  if (!response.ok) return { ok: false, error: await apiError(response, options.fallback) }
  const text = await response.text()
  return { ok: true, body: (text ? JSON.parse(text) : null) as T }
}
