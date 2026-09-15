'use client'

import { SidebarSimple, SignOut } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { LanguageSwitcher } from '@/components/shell/language-switcher'
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
  const t = useTranslations('shell')
  const router = useRouter()
  const control = collapsed ? t('expandSidebar') : t('collapseSidebar')

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
        <LanguageSwitcher />
        <span className="avatar">{session?.name?.slice(0, 1) ?? 'H'}</span>
        <span className="user-identity">
          <strong>{session?.name ?? t('loadingUser')}</strong>
          <small>{session?.email ?? ''}</small>
        </span>
        <Button aria-label={t('signOut')} className="signout-button" onClick={logout} type="button">
          <SignOut aria-hidden="true" size={16} />
          <span>{t('signOut')}</span>
        </Button>
      </div>
    </header>
  )
}
