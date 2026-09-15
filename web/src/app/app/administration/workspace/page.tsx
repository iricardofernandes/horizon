'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { type Workspace, WorkspaceView } from '@/features/settings/workspace-view'
import { readJson } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readJson<Workspace>('identity.workspace', '/api/horizon/identity/workspace')
}

export default function WorkspaceSettingsPage() {
  const session = useSession()
  const setNotice = useNotice()
  const state = useLoader(load)
  // Visibility only: Identity refuses the write regardless of what this decides (ADR 0045).
  const canManage = (session?.roles ?? []).some(
    (assignment) => assignment.module === 'identity' && assignment.role === 'owner',
  )
  return (
    <Resource state={state}>
      {(workspace) => (
        <WorkspaceView
          canManage={canManage}
          onChanged={state.reload}
          setNotice={setNotice}
          user={session}
          workspace={workspace}
        />
      )}
    </Resource>
  )
}
