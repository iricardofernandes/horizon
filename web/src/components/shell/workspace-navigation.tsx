'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { NavigationGroup } from '@/lib/navigation'

export function WorkspaceNavigation({ groups }: { groups: readonly NavigationGroup[] }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Workspace navigation">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="sidebar-section-label">{group.label}</p>
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
                <span className="nav-label">{entry.label}</span>
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
