'use client'

import { useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import type { Customer } from '@/features/sales/customers-view'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'
import { SalesView, type Screen } from './sales-view'
import { SALES_API, type SalesData } from './types'

export type SalesScreenData = SalesData & {
  customers: Customer[]
  items: CatalogItem[]
  warehouses: Warehouse[]
}

/**
 * Every sales screen reads the same collections.
 *
 * The offers, the orders and the deliveries are one chain of documents seen from three
 * places, so reading them once and filtering in the browser is what keeps the approval
 * queue and the board from ever disagreeing about what is waiting.
 */
export async function loadSales(): Promise<SalesScreenData> {
  const [quotes, orders, shipments, customers, warehouses, items] = await Promise.all([
    readJson<SalesData['quotes']>('sales.quotes', `${SALES_API}/quotes`),
    readJson<SalesData['orders']>('sales.orders', `${SALES_API}/orders`),
    readJson<SalesData['shipments']>('sales.shipments', `${SALES_API}/shipments`),
    readJson<Customer[]>('sales.customers', `${SALES_API}/customers`),
    readJson<Warehouse[]>('inventory.warehouses', '/api/horizon/inventory/warehouses'),
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100'),
  ])
  return { quotes, orders, shipments, customers, warehouses, items }
}

export function SalesPage({ screen }: { screen: Screen }) {
  const session = useSession()
  const state = useLoader(loadSales)
  // Visibility only: Sales refuses what a role does not permit (ADR 0023, ADR 0045).
  const roles = (session?.roles ?? [])
    .filter((assignment) => assignment.module === 'sales')
    .map((assignment) => assignment.role)
  const abilities = {
    canWrite: roles.includes('admin') || roles.includes('representative'),
    userId: session?.id ?? null,
  }
  return (
    <Resource state={state}>
      {(data) => (
        <SalesView abilities={abilities} data={data} onChanged={state.reload} screen={screen} />
      )}
    </Resource>
  )
}
