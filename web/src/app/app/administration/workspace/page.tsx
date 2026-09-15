'use client'

import { useSession } from '@/components/shell/workspace-context'
import { WorkspaceView } from '@/features/settings/workspace-view'

export default function WorkspaceSettingsPage() {
  const session = useSession()
  return <WorkspaceView user={session} workspaceName={session?.workspace?.name ?? 'Workspace'} />
}
