'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { DeliveriesView, type Delivery } from '@/features/developers/deliveries-view'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readJson<Delivery[]>('webhooks.deliveries', '/api/horizon/webhooks/webhook-deliveries')
}

export default function DeliveriesPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(deliveries) => (
        <DeliveriesView deliveries={deliveries} onChanged={state.reload} setNotice={setNotice} />
      )}
    </Resource>
  )
}
