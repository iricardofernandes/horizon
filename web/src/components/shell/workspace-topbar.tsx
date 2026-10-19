'use client'

import { SidebarSimple } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { CommandPalette } from '@/components/shell/command-palette'
import { NotificationBell } from '@/components/shell/notification-bell'
import { UserMenu } from '@/components/shell/user-menu'
import type { SessionUser } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'

export function WorkspaceTopbar({
  session,
  workspaceName,
  title,
  collapsed,
  onToggleSidebar,
}: {
  session: SessionUser | null
  workspaceName: string
  title: string
  collapsed: boolean
  onToggleSidebar: () => void
}) {
  const t = useTranslations('shell')
  const control = collapsed ? t('expandSidebar') : t('collapseSidebar')

  return (
    <header className="topbar">
      <div className="topbar-leading">
        <Button
          aria-controls="workspace-sidebar"
          aria-expanded={!collapsed}
          aria-label={control}
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          title={control}
          type="button"
        >
          <SidebarSimple aria-hidden="true" size={18} weight={collapsed ? 'regular' : 'fill'} />
        </Button>
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
