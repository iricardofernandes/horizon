'use client'

import { useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { AssistantSettingsView } from '@/features/assistant/assistant-settings'
import { readJson } from '@/lib/api'
import type { AssistantStatus } from '@/lib/assistant'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readJson<AssistantStatus>('assistant.status', '/api/horizon/agent/assistant/status')
}

export default function AssistantSettingsPage() {
  const session = useSession()
  const state = useLoader(load)
  // Visibility only: the agent refuses anyone else (Phase 76).
  const isOwner = (session?.roles ?? []).some(
    (role) => role.module === 'identity' && role.role === 'owner',
  )
  return (
    <Resource state={state}>
      {(status) => (
        <AssistantSettingsView isOwner={isOwner} onChanged={state.reload} status={status} />
      )}
    </Resource>
  )
}
