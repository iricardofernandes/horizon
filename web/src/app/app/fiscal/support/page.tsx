'use client'

import { Resource } from '@/components/ui/resource'
import { type SupportData, SupportView } from '@/features/fiscal/support-view'
import { type DocumentKind, FISCAL_API, type SupportOverview } from '@/features/fiscal/types'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load(): Promise<SupportData> {
  const [overview, kinds] = await Promise.all([
    readJson<SupportOverview>('fiscal.support.overview', `${FISCAL_API}/support/overview`),
    readJson<{ kinds: DocumentKind[] }>('fiscal.document-kinds', `${FISCAL_API}/document-kinds`),
  ])
  return { overview, kinds: kinds.kinds }
}

export default function FiscalSupportPage() {
  const state = useLoader(load)
  return <Resource state={state}>{(data) => <SupportView data={data} />}</Resource>
}
