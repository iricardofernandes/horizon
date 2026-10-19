'use client'

import { Menu } from '@base-ui/react/menu'
import { SignOut, UserCircle } from '@phosphor-icons/react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { SessionUser } from '@/components/shell/workspace-context'
import { tracedFetch } from '@/lib/telemetry'

/**
 * The signed-in person, as their initial: who they are, their own settings and the way out.
 *
 * The top bar is read on every screen, so it carries only what is used on every screen;
 * what a person does once in a while waits behind their avatar.
 */
export function UserMenu({ session }: { session: SessionUser | null }) {
  const t = useTranslations('shell')
  const router = useRouter()
  const name = session?.name ?? t('loadingUser')

  async function logout() {
    await tracedFetch('session.logout', '/api/session', { method: 'DELETE' })
    window.localStorage.removeItem('horizon.activeWorkspace')
    router.replace('/login')
  }

  return (
    <Menu.Root>
      <Menu.Trigger aria-label={t('userMenu', { name })} className="avatar-trigger">
        <span aria-hidden="true" className="avatar">
          {session?.name?.slice(0, 1).toUpperCase() ?? 'H'}
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" className="ui-menu-positioner" sideOffset={8}>
          <Menu.Popup className="ui-menu-popup">
            <div className="user-menu-identity">
              <strong>{name}</strong>
              <small>{session?.email ?? ''}</small>
            </div>
            <Menu.Separator className="ui-menu-separator" />
            <Menu.LinkItem
              className="ui-menu-item"
              closeOnClick
              render={<Link href="/app/settings/profile" />}
            >
              <UserCircle aria-hidden="true" size={16} />
              {t('profileSettings')}
            </Menu.LinkItem>
            <Menu.Item className="ui-menu-item" onClick={() => void logout()}>
              <SignOut aria-hidden="true" size={16} />
              {t('signOut')}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
