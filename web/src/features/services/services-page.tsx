'use client'

import { Resource } from '@/components/ui/resource'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'
import { type BillingData, BillingView } from './billing-view'
import { ContractsView } from './contracts-view'
import { ServiceOrdersView } from './service-orders-view'
import { loadServices, useServiceAbilities } from './services-data'
import { type BillingOverview, SALES_API } from './types'

async function loadBilling(): Promise<BillingData> {
  const [services, overview] = await Promise.all([
    loadServices(),
    readJson<BillingOverview>(
      'sales.contract-billing.overview',
      `${SALES_API}/contract-billing/overview`,
    ),
  ])
  return { ...services, overview }
}

/** The three service screens, each over the same documents (ADR 0056). */
export function ServicesPage({ screen }: { screen: 'orders' | 'contracts' }) {
  const abilities = useServiceAbilities()
  const state = useLoader(loadServices)
  return (
    <Resource state={state}>
      {(data) =>
        screen === 'orders' ? (
          <ServiceOrdersView canWrite={abilities.canWrite} data={data} onChanged={state.reload} />
        ) : (
          <ContractsView canWrite={abilities.canWrite} data={data} onChanged={state.reload} />
        )
      }
    </Resource>
  )
}

export function BillingPage() {
  const abilities = useServiceAbilities()
  const state = useLoader(loadBilling)
  return (
    <Resource state={state}>
      {(data) => <BillingView canWrite={abilities.canWrite} data={data} onChanged={state.reload} />}
    </Resource>
  )
}
