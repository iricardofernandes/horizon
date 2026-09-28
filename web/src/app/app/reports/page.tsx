'use client'

import { Resource } from '@/components/ui/resource'
import { ReportsView } from '@/features/reports/reports-view'
import { readJson, readPage } from '@/lib/api'
import { type Dashboard, REPORTING_API, type ReportCatalogEntry } from '@/lib/reports'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const [catalog, dashboard] = await Promise.all([
    readPage<ReportCatalogEntry>('reporting.catalog', `${REPORTING_API}/reports`),
    readJson<Dashboard>('reporting.dashboard', `${REPORTING_API}/dashboard`),
  ])
  return { catalog, dashboard }
}

export default function ReportsPage() {
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(data) => <ReportsView catalog={data.catalog} dashboard={data.dashboard} />}
    </Resource>
  )
}
