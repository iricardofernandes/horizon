'use client'

import { SidebarSimple, SignOut } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import type { SessionUser } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { tracedFetch } from '@/lib/telemetry'

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
  const router = useRouter()
  const control = collapsed ? 'Expand sidebar' : 'Collapse sidebar'

  async function logout() {
    await tracedFetch('session.logout', '/api/session', { method: 'DELETE' })
    window.localStorage.removeItem('horizon.activeWorkspace')
    router.replace('/login')
  }

  return (
    <header className="topbar">
      <div className="topbar-leading">
        <Button
          aria-controls="workspace-sidebar"
          aria-label={control}
          aria-pressed={collapsed}
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          title={control}
          type="button"
        >
          <SidebarSimple aria-hidden="true" size={18} weight="bold" />
        </Button>
        <div>
          <p className="topbar-kicker">{workspaceName}</p>
          <strong>{title}</strong>
        </div>
      </div>
      <div className="user-menu">
        <span className="avatar">{session?.name?.slice(0, 1) ?? 'H'}</span>
        <span>
          <strong>{session?.name ?? 'Loading…'}</strong>
          <small>{session?.email ?? ''}</small>
        </span>
        <Button aria-label="Sign out" className="signout-button" onClick={logout} type="button">
          <SignOut aria-hidden="true" size={16} />
          <span>Sign out</span>
        </Button>
      </div>
    </header>
  )
}
