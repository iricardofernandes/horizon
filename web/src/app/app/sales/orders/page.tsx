'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import type { Customer } from '@/features/sales/customers-view'
import { type Order, OrdersView } from '@/features/sales/orders-view'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const [orders, customers, warehouses, items] = await Promise.all([
    readJson<Order[]>('sales.orders', '/api/horizon/sales/orders'),
    readJson<Customer[]>('sales.customers', '/api/horizon/sales/customers'),
    readJson<Warehouse[]>('inventory.warehouses', '/api/horizon/inventory/warehouses'),
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100'),
  ])
  return { orders, customers, warehouses, items }
}

export default function OrdersPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => (
        <OrdersView
          items={data.items}
          customers={data.customers}
          warehouses={data.warehouses}
          orders={data.orders}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
