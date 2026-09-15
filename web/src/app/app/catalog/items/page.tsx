'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import {
  type CatalogItem,
  type CatalogPriceList,
  type CatalogUnit,
  CatalogView,
} from '@/features/catalog/catalog-view'
import type { Warehouse } from '@/features/inventory/inventory-view'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

const hostedDemo = process.env.NEXT_PUBLIC_HORIZON_HOSTED_DEMO === 'true'

async function load() {
  const [items, priceLists] = await Promise.all([
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100'),
    readPage<CatalogPriceList>('catalog.price-lists', '/api/horizon/catalog/price-lists?limit=100'),
  ])
  if (hostedDemo) return { items, priceLists, units: [] as CatalogUnit[], warehouses: [] }
  const [units, warehouses] = await Promise.all([
    readPage<CatalogUnit>('catalog.units', '/api/horizon/catalog/units?limit=100'),
    readJson<Warehouse[]>('inventory.warehouses', '/api/horizon/inventory/warehouses'),
  ])
  return { items, priceLists, units, warehouses }
}

export default function CatalogItemsPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => (
        <CatalogView
          items={data.items}
          units={data.units}
          priceLists={data.priceLists}
          warehouses={data.warehouses}
          readOnly={hostedDemo}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
