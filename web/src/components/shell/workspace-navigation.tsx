'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { NavigationGroup } from '@/lib/navigation'

export function WorkspaceNavigation({ groups }: { groups: readonly NavigationGroup[] }) {
  const t = useTranslations('navigation')
  const shell = useTranslations('shell')
  const pathname = usePathname()
  return (
    <nav aria-label={shell('navigationLabel')}>
      {groups.map((group) => (
        <div key={group.labelKey}>
          <p className="sidebar-section-label">{t(`groups.${group.labelKey}`)}</p>
          {group.entries.map((entry) => {
            const NavigationIcon = entry.icon
            const active = pathname === entry.href
            return (
              <Link
                aria-current={active ? 'page' : undefined}
                className={active ? 'nav-item active' : 'nav-item'}
                href={entry.href}
                key={entry.href}
              >
                <span className="nav-glyph" aria-hidden="true">
                  <NavigationIcon size={18} weight={active ? 'fill' : 'regular'} />
                </span>
                <span className="nav-label">{t(`items.${entry.labelKey}`)}</span>
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
