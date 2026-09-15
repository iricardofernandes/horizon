import type { Icon } from '@phosphor-icons/react'
import {
  ChartBar,
  FileText,
  Gear,
  Key,
  Package,
  PaperPlaneTilt,
  ShieldCheck,
  ShoppingCart,
  UsersThree,
  Warehouse,
  WebhooksLogo,
} from '@phosphor-icons/react'

export type RoleAssignment = { module: string; role: string }

export type NavigationEntry = {
  href: string
  label: string
  icon: Icon
  /**
   * The module a user must hold any role in to see this entry, or null when the screen
   * needs no module role. Visibility only — each service still enforces the role itself
   * (ADR 0023, ADR 0045).
   */
  module: string | null
  /** Present in the public hosted-demo profile. */
  demo: boolean
}

export type NavigationGroup = { label: string; entries: readonly NavigationEntry[] }

export const navigation: readonly NavigationGroup[] = [
  {
    label: 'Overview',
    entries: [{ href: '/app', label: 'Overview', icon: ChartBar, module: null, demo: true }],
  },
  {
    label: 'Catalog',
    entries: [
      { href: '/app/catalog/items', label: 'Items', icon: Package, module: 'catalog', demo: true },
    ],
  },
  {
    label: 'Sales',
    entries: [
      {
        href: '/app/sales/customers',
        label: 'Customers',
        icon: UsersThree,
        module: 'sales',
        demo: false,
      },
      { href: '/app/sales/quotes', label: 'Quotes', icon: FileText, module: 'sales', demo: false },
      {
        href: '/app/sales/orders',
        label: 'Orders',
        icon: ShoppingCart,
        module: 'sales',
        demo: false,
      },
    ],
  },
  {
    label: 'Inventory',
    entries: [
      {
        href: '/app/inventory/balances',
        label: 'Balances',
        icon: Warehouse,
        module: 'inventory',
        demo: false,
      },
    ],
  },
  {
    label: 'Developers',
    entries: [
      {
        href: '/app/developers/api-keys',
        label: 'API keys',
        icon: Key,
        module: 'identity',
        demo: false,
      },
      {
        href: '/app/developers/webhooks',
        label: 'Webhooks',
        icon: WebhooksLogo,
        module: 'webhooks',
        demo: false,
      },
      {
        href: '/app/developers/deliveries',
        label: 'Delivery logs',
        icon: PaperPlaneTilt,
        module: 'webhooks',
        demo: false,
      },
    ],
  },
  {
    label: 'Administration',
    entries: [
      {
        href: '/app/administration/people',
        label: 'People and access',
        icon: ShieldCheck,
        module: 'identity',
        demo: false,
      },
      {
        href: '/app/administration/workspace',
        label: 'Workspace',
        icon: Gear,
        module: null,
        demo: true,
      },
    ],
  },
]

export const navigationEntries: readonly NavigationEntry[] = navigation.flatMap(
  (group) => group.entries,
)

export function holdsModule(roles: readonly RoleAssignment[], module: string | null): boolean {
  return module === null || roles.some((assignment) => assignment.module === module)
}

export function isEntryVisible(
  entry: NavigationEntry,
  roles: readonly RoleAssignment[],
  hostedDemo: boolean,
): boolean {
  if (hostedDemo) return entry.demo
  return holdsModule(roles, entry.module)
}

export function visibleNavigation(
  roles: readonly RoleAssignment[],
  hostedDemo: boolean,
): NavigationGroup[] {
  return navigation
    .map((group) => ({
      label: group.label,
      entries: group.entries.filter((entry) => isEntryVisible(entry, roles, hostedDemo)),
    }))
    .filter((group) => group.entries.length > 0)
}

/** The registry entry a pathname belongs to, preferring the longest matching route. */
export function entryForPath(pathname: string): NavigationEntry | undefined {
  return [...navigationEntries]
    .sort((left, right) => right.href.length - left.href.length)
    .find((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`))
}
