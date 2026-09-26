'use client'

import { Resource } from '@/components/ui/resource'
import { PreviewView } from '@/features/fiscal/preview-view'
import { FISCAL_API, type SupportOverview } from '@/features/fiscal/types'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readJson<SupportOverview>('fiscal.support.overview', `${FISCAL_API}/support/overview`)
}

export default function FiscalPreviewPage() {
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(overview) => <PreviewView capabilities={overview.capabilities} />}
    </Resource>
  )
}
