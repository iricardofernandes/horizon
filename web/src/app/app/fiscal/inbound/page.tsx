'use client'

import { Resource } from '@/components/ui/resource'
import { InboundView } from '@/features/fiscal/inbound-view'
import { FISCAL_API, type ImportSummary } from '@/features/fiscal/types'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readPage<ImportSummary>('fiscal.imports.list', `${FISCAL_API}/imports?limit=100`)
}

export default function FiscalInboundPage() {
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(imports) => <InboundView imports={imports} onChanged={state.reload} />}
    </Resource>
  )
}
