'use client'

import { useNotice } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { type ApiKeyRecord, ApiKeysView } from '@/features/developers/api-keys-view'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

async function load() {
  const exported = await readJson<{ apiKeys: ApiKeyRecord[] }>(
    'identity.me.export',
    '/api/horizon/identity/me/export',
  )
  return exported.apiKeys
}

export default function ApiKeysPage() {
  const setNotice = useNotice()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(apiKeys) => (
        <ApiKeysView apiKeys={apiKeys} onChanged={state.reload} setNotice={setNotice} />
      )}
    </Resource>
  )
}
