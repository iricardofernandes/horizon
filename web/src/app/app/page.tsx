'use client'

import { Resource } from '@/components/ui/resource'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Delivery } from '@/features/developers/deliveries-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import { OverviewView } from '@/features/overview/overview-view'
import type { Order } from '@/features/sales/orders-view'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

const hostedDemo = process.env.NEXT_PUBLIC_HORIZON_HOSTED_DEMO === 'true'

async function load() {
  const items = await readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100')
  if (hostedDemo) return { items, orders: [], deliveries: [], warehouses: [] }
  const [orders, deliveries, warehouses] = await Promise.all([
    readJson<Order[]>('sales.orders', '/api/horizon/sales/orders'),
    readJson<Delivery[]>('webhooks.deliveries', '/api/horizon/webhooks/webhook-deliveries'),
    readJson<Warehouse[]>('inventory.warehouses', '/api/horizon/inventory/warehouses'),
  ])
  return { items, orders, deliveries, warehouses }
}

export default function OverviewPage() {
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => (
        <OverviewView
          items={data.items}
          orders={data.orders}
          deliveries={data.deliveries}
          warehouses={data.warehouses}
        />
      )}
    </Resource>
  )
}
