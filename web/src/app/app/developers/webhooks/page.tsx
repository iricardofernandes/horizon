'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { type Subscription, WebhooksView } from '@/features/developers/webhooks-view'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readJson<Subscription[]>(
    'webhooks.subscriptions',
    '/api/horizon/webhooks/webhook-subscriptions',
  )
}

export default function WebhooksPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(subscriptions) => (
        <WebhooksView
          subscriptions={subscriptions}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
