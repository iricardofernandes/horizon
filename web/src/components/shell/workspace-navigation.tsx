'use client'

import { NavigationMenu } from '@base-ui/react/navigation-menu'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useSyncExternalStore } from 'react'
import { entryForPath, groupForPath, type NavigationGroup } from '@/lib/navigation'

/** Below this width the rail lies along the bottom edge, and its panel opens upward. */
const BOTTOM_RAIL = '(max-width: 760px)'

function watchBottomRail(notify: () => void) {
  const query = window.matchMedia(BOTTOM_RAIL)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

function useBottomRail(): boolean {
  return useSyncExternalStore(
    watchBottomRail,
    () => window.matchMedia(BOTTOM_RAIL).matches,
    () => false,
  )
}

/**
 * The modules as a rail of glyphs; a module's screens open beside it.
 *
 * Forty screens do not fit a column a reader can scan, and eleven modules do. The rail
 * names where the reader is, and the panel is the only place a screen's name is written,
 * so each is found by its module first (ADR 0045, ADR 0078).
 */
export function WorkspaceNavigation({ groups }: { groups: readonly NavigationGroup[] }) {
  const t = useTranslations('navigation')
  const shell = useTranslations('shell')
  const pathname = usePathname()
  const bottom = useBottomRail()
  const currentGroup = groupForPath(groups, pathname)
  const currentEntry = entryForPath(pathname)

  return (
    <NavigationMenu.Root
      aria-label={shell('navigationLabel')}
      className="rail"
      closeDelay={120}
      orientation={bottom ? 'horizontal' : 'vertical'}
    >
      <NavigationMenu.List className="rail-list">
        {groups.map((group) => {
          const GroupIcon = group.icon
          const current = group === currentGroup
          const label = t(`groups.${group.labelKey}`)
          return (
            <NavigationMenu.Item key={group.labelKey} value={group.labelKey}>
              <NavigationMenu.Trigger
                aria-label={label}
                className={current ? 'rail-trigger active' : 'rail-trigger'}
              >
                <GroupIcon aria-hidden="true" size={20} weight={current ? 'fill' : 'regular'} />
              </NavigationMenu.Trigger>
              <NavigationMenu.Content className="rail-content">
                <p className="rail-heading">{label}</p>
                <ul className="rail-links">
                  {group.entries.map((entry) => {
                    const EntryIcon = entry.icon
                    const active = entry.href === currentEntry?.href
                    return (
                      <li key={entry.href}>
                        <NavigationMenu.Link
                          active={active}
                          className="rail-link"
                          closeOnClick
                          render={<Link href={entry.href} />}
                        >
                          <EntryIcon
                            aria-hidden="true"
                            size={16}
                            weight={active ? 'fill' : 'regular'}
                          />
                          <span>{t(`items.${entry.labelKey}`)}</span>
                        </NavigationMenu.Link>
                      </li>
                    )
                  })}
                </ul>
              </NavigationMenu.Content>
            </NavigationMenu.Item>
          )
        })}
      </NavigationMenu.List>
      <NavigationMenu.Portal>
        <NavigationMenu.Positioner
          align="start"
          className="rail-positioner"
          collisionPadding={12}
          side={bottom ? 'top' : 'right'}
          sideOffset={bottom ? 12 : 14}
        >
          <NavigationMenu.Popup aria-label={shell('navigationLabel')} className="rail-popup">
            <NavigationMenu.Viewport className="rail-viewport" />
          </NavigationMenu.Popup>
        </NavigationMenu.Positioner>
      </NavigationMenu.Portal>
    </NavigationMenu.Root>
  )
}
