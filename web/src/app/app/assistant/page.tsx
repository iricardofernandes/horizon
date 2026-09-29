'use client'

import { useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { type AssistantState, AssistantView } from '@/features/assistant/assistant-view'
import { readJson } from '@/lib/api'
import type { AssistantStatus, ConversationSummary } from '@/lib/assistant'
import { useLoader } from '@/lib/use-loader'

async function load(): Promise<Omit<AssistantState, 'canManage'>> {
  const [status, conversations] = await Promise.all([
    readJson<AssistantStatus>('assistant.status', '/api/horizon/agent/assistant/status'),
    readJson<{ data: ConversationSummary[] }>(
      'assistant.conversations',
      '/api/horizon/agent/assistant/conversations',
    ),
  ])
  return { status, conversations: conversations.data }
}

export default function AssistantPage() {
  const session = useSession()
  const state = useLoader(load)
  // Visibility only: the agent refuses a change from anyone else (Phase 76).
  const canManage = (session?.roles ?? []).some(
    (role) => role.module === 'identity' && (role.role === 'owner' || role.role === 'admin'),
  )
  return (
    <Resource state={state}>
      {(value) => <AssistantView onChanged={state.reload} state={{ ...value, canManage }} />}
    </Resource>
  )
}
