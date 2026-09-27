'use client'

import { Resource } from '@/components/ui/resource'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import type { ServiceProfile } from '@/features/fiscal/service-profiles'
import {
  type ServiceItemProfiles,
  ServiceProfilesView,
} from '@/features/fiscal/service-profiles-view'
import { FISCAL_API } from '@/features/fiscal/types'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

const MAX_PAGES = 10

/** Every Catalog service, with the revisions of its fiscal profile. */
async function load(): Promise<ServiceItemProfiles[]> {
  const services: CatalogItem[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })
    const result = await readJson<{
      data: CatalogItem[]
      page: { hasMore: boolean; nextCursor?: string }
    }>('catalog.items', `/api/horizon/catalog/items?${query}`)
    services.push(...result.data.filter((item) => item.kind === 'service'))
    if (!result.page.hasMore || !result.page.nextCursor) break
    cursor = result.page.nextCursor
  }
  return Promise.all(
    services.map(async (item) => {
      const profiles = await readJson<{ revisions: ServiceProfile[] }>(
        'fiscal.service-profiles.list',
        `${FISCAL_API}/service-profiles/${item.id}`,
      )
      return {
        itemId: item.id,
        name: item.name,
        sku: item.sku,
        active: item.active,
        revisions: profiles.revisions,
      }
    }),
  )
}

export default function FiscalServiceProfilesPage() {
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(items) => <ServiceProfilesView items={items} onChanged={state.reload} />}
    </Resource>
  )
}
