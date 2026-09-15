'use client'

import { useNotice, useSession } from '@/components/shell/workspace-context'
import { Resource } from '@/components/ui/resource'
import { AccessView, type WorkspaceUser } from '@/features/access/access-view'
import { readPage } from '@/lib/api'
import { useLoader } from '@/lib/use-loader'

function load() {
  return readPage<WorkspaceUser>('identity.users', '/api/horizon/identity/users?limit=100')
}

export default function PeoplePage() {
  const setNotice = useNotice()
  const session = useSession()
  const state = useLoader(load)
  return (
    <Resource state={state}>
      {(users) => (
        <AccessView
          users={users}
          currentUserId={session?.id}
          onChanged={state.reload}
          setNotice={setNotice}
        />
      )}
    </Resource>
  )
}
