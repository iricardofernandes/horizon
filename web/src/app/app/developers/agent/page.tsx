'use client'

import { useCallback } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { type AgentState, AgentView } from '@/features/developers/agent-view'
import { type AgentSettings, callOf } from '@/lib/agent'
import { SessionExpiredError } from '@/lib/api'
import { tracedFetch } from '@/lib/telemetry'
import { useLoader } from '@/lib/use-loader'

type AuditPage = {
  data: Parameters<typeof callOf>[0][]
  chain: { status: 'intact' | 'broken' }
}

/** A read that the person may simply not be allowed: null then, not an error screen. */
async function optional<T>(name: string, url: string): Promise<T | null> {
  const response = await tracedFetch(name, url, { cache: 'no-store' })
  if (response.status === 401) throw new SessionExpiredError(name)
  if (response.status === 403) return null
  if (!response.ok) throw new Error(name)
  return (await response.json()) as T
}

export default function AgentPage() {
  const session = useSession()
  const tenantId = session?.workspace?.tenantId ?? ''
  // Stable per workspace: `useLoader` loads again whenever its function changes, so an inline
  // one would ask the agent on every render (Phase 78 found this page doing it).
  const load = useCallback(async (): Promise<AgentState> => {
    const [settings, audit] = await Promise.all([
      optional<AgentSettings>('agent.settings', '/api/horizon/agent/settings'),
      optional<AuditPage>(
        'agent.audit',
        '/api/horizon/agent/audit?action=agent.tool.called&limit=50',
      ),
    ])
    return {
      tenantId,
      settings,
      calls: audit ? audit.data.map(callOf) : null,
      chain: audit ? audit.chain.status : null,
    }
  }, [tenantId])
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(value) => <AgentView onChanged={state.reload} state={value} />}
    </Resource>
  )
}
