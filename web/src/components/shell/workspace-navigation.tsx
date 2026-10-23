'use client'

import { NavigationMenu } from '@base-ui/react/navigation-menu'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState, useSyncExternalStore } from 'react'
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
 * Marks which ends of a scrolling list hide more of it, so the stylesheet can fade them.
 *
 * Eleven modules outgrow a phone's width and a short window's height; a list cut at an
 * edge reads as complete unless that edge says otherwise. The modules arrive with the
 * session, after the list is drawn, so new items are watched as well as the list's size.
 * The axis is whichever one the list scrolls along.
 */
function watchOverflowEdges(list: HTMLElement | null) {
  if (!list) return
  function mark() {
    if (!list) return
    const horizontal = list.scrollWidth > list.clientWidth
    const start = horizontal ? list.scrollLeft : list.scrollTop
    const room = horizontal
      ? list.scrollWidth - list.clientWidth
      : list.scrollHeight - list.clientHeight
    list.toggleAttribute('data-overflow-start', start > 1)
    list.toggleAttribute('data-overflow-end', start < room - 1)
  }
  mark()
  const resize = new ResizeObserver(mark)
  resize.observe(list)
  const items = new MutationObserver(mark)
  items.observe(list, { childList: true })
  list.addEventListener('scroll', mark, { passive: true })
  return () => {
    resize.disconnect()
    items.disconnect()
    list.removeEventListener('scroll', mark)
  }
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
  // Whether the reader is moving through the rail with keys, so its panel opens without motion.
  const [byKeyboard, setByKeyboard] = useState(false)
  // The module whose panel is open, and whether a press opened it. A hover opens a panel
  // for a glance and the pointer leaving closes it; a press keeps it open until the reader
  // presses its glyph again, presses elsewhere, leaves with Escape or follows a link.
  const [open, setOpen] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)

  function press(module: string) {
    const closing = pinned && open === module
    setPinned(!closing)
    setOpen(closing ? null : module)
  }

  function change(next: string | null, details: NavigationMenu.Root.ChangeEventDetails) {
    // A press is settled by `press`; a pinned panel outlives the pointer leaving it.
    const leftPinned = pinned && next === null && details.reason === 'trigger-hover'
    if (details.reason === 'trigger-press' || leftPinned) {
      details.cancel()
      return
    }
    if (next === null) setPinned(false)
    setOpen(next)
  }

  return (
    <NavigationMenu.Root
      aria-label={shell('navigationLabel')}
      className="rail"
      closeDelay={120}
      onKeyDown={() => setByKeyboard(true)}
      onPointerMove={() => setByKeyboard(false)}
      onValueChange={change}
      orientation={bottom ? 'horizontal' : 'vertical'}
      value={open}
    >
      <NavigationMenu.List className="rail-list" ref={watchOverflowEdges}>
        {groups.map((group) => {
          const GroupIcon = group.icon
          const current = group === currentGroup
          const label = t(`groups.${group.labelKey}`)
          return (
            <NavigationMenu.Item key={group.labelKey} value={group.labelKey}>
              <NavigationMenu.Trigger
                aria-current={current ? 'true' : undefined}
                aria-label={label}
                className={current ? 'rail-trigger active' : 'rail-trigger'}
                onClick={() => press(group.labelKey)}
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
          data-keyboard={byKeyboard || undefined}
          side={bottom ? 'top' : 'right'}
          sideOffset={bottom ? 12 : 14}
        >
          {/* The rail is already the navigation landmark; its panel is part of it, not a second one. */}
          <NavigationMenu.Popup className="rail-popup" render={<div />}>
            <NavigationMenu.Viewport className="rail-viewport" />
          </NavigationMenu.Popup>
        </NavigationMenu.Positioner>
      </NavigationMenu.Portal>
    </NavigationMenu.Root>
  )
}
