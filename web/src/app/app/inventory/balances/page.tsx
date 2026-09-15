'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import { InventoryView, type Warehouse } from '@/features/inventory/inventory-view'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const [warehouses, items] = await Promise.all([
    readJson<Warehouse[]>('inventory.warehouses', '/api/horizon/inventory/warehouses'),
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100'),
  ])
  return { warehouses, items }
}

export default function InventoryBalancesPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => (
        <InventoryView
          items={data.items}
          warehouses={data.warehouses}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
