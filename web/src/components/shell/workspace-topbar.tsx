'use client'

import { SidebarSimple, SignOut, Sparkle } from '@phosphor-icons/react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CommandPalette } from '@/components/shell/command-palette'
import { LanguageSwitcher } from '@/components/shell/language-switcher'
import { NotificationBell } from '@/components/shell/notification-bell'
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
        <CommandPalette />
        <Link
          aria-label={t('assistant')}
          className="ui-button ui-button-ghost"
          href="/app/assistant"
        >
          <Sparkle aria-hidden="true" size={16} />
          <span className="topbar-assistant-label">{t('assistant')}</span>
        </Link>
        <NotificationBell />
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
