'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { Customer } from '@/features/sales/customers-view'
import { type Quote, QuotesView } from '@/features/sales/quotes-view'
import { readJson, readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const [quotes, customers, items] = await Promise.all([
    readJson<Quote[]>('sales.quotes', '/api/horizon/sales/quotes'),
    readJson<Customer[]>('sales.customers', '/api/horizon/sales/customers'),
    readPage<CatalogItem>('catalog.items', '/api/horizon/catalog/items?limit=100'),
  ])
  return { quotes, customers, items }
}

export default function QuotesPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => (
        <QuotesView
          quotes={data.quotes}
          customers={data.customers}
          items={data.items}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
