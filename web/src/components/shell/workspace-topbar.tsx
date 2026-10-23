'use client'

import { CommandPalette } from '@/components/shell/command-palette'
import { NotificationBell } from '@/components/shell/notification-bell'
import { UserMenu } from '@/components/shell/user-menu'
import type { SessionUser } from '@/components/shell/workspace-context'

export function WorkspaceTopbar({
  session,
  workspaceName,
  title,
}: {
  session: SessionUser | null
  workspaceName: string
  title: string
}) {
  return (
    <header className="topbar">
      <div className="topbar-leading">
        <div>
          <p className="topbar-kicker">{workspaceName}</p>
          <strong>{title}</strong>
        </div>
      </div>
      <div className="user-menu">
        <CommandPalette />
        <NotificationBell />
        <UserMenu session={session} />
      </div>
    </header>
  )
}
