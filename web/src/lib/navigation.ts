import type { Icon } from '@phosphor-icons/react'
import {
  AddressBook,
  Bank,
  BookOpen,
  Books,
  ChartBar,
  CheckSquareOffset,
  FileText,
  Gear,
  HandCoins,
  Invoice,
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
  /** Key inside the `navigation.items` namespace; never display copy (ADR 0044). */
  labelKey: string
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

export type NavigationGroup = { labelKey: string; entries: readonly NavigationEntry[] }

export const navigation: readonly NavigationGroup[] = [
  {
    labelKey: 'overview',
    entries: [{ href: '/app', labelKey: 'overview', icon: ChartBar, module: null, demo: true }],
  },
  {
    labelKey: 'registrations',
    entries: [
      {
        href: '/app/registrations/parties',
        labelKey: 'parties',
        icon: AddressBook,
        module: 'parties',
        demo: false,
      },
    ],
  },
  {
    labelKey: 'catalog',
    entries: [
      {
        href: '/app/catalog/items',
        labelKey: 'items',
        icon: Package,
        module: 'catalog',
        demo: true,
      },
    ],
  },
  {
    labelKey: 'sales',
    entries: [
      {
        href: '/app/sales/customers',
        labelKey: 'customers',
        icon: UsersThree,
        module: 'sales',
        demo: false,
      },
      {
        href: '/app/sales/quotes',
        labelKey: 'quotes',
        icon: FileText,
        module: 'sales',
        demo: false,
      },
      {
        href: '/app/sales/orders',
        labelKey: 'orders',
        icon: ShoppingCart,
        module: 'sales',
        demo: false,
      },
    ],
  },
  {
    labelKey: 'finance',
    entries: [
      {
        href: '/app/finance/receivables',
        labelKey: 'receivables',
        icon: HandCoins,
        module: 'financial',
        demo: false,
      },
      {
        href: '/app/finance/payables',
        labelKey: 'payables',
        icon: Invoice,
        module: 'financial',
        demo: false,
      },
      {
        href: '/app/finance/treasury',
        labelKey: 'treasury',
        icon: Bank,
        module: 'treasury',
        demo: false,
      },
      {
        href: '/app/finance/ledger',
        labelKey: 'ledger',
        icon: BookOpen,
        module: 'ledger',
        demo: false,
      },
      {
        href: '/app/finance/reconciliation',
        labelKey: 'reconciliation',
        icon: CheckSquareOffset,
        module: 'treasury',
        demo: false,
      },
    ],
  },
  {
    labelKey: 'inventory',
    entries: [
      {
        href: '/app/inventory/balances',
        labelKey: 'balances',
        icon: Warehouse,
        module: 'inventory',
        demo: false,
      },
    ],
  },
  {
    labelKey: 'developers',
    entries: [
      {
        href: '/app/developers/api-keys',
        labelKey: 'apiKeys',
        icon: Key,
        module: 'identity',
        demo: false,
      },
      {
        href: '/app/developers/webhooks',
        labelKey: 'webhooks',
        icon: WebhooksLogo,
        module: 'webhooks',
        demo: false,
      },
      {
        href: '/app/developers/deliveries',
        labelKey: 'deliveries',
        icon: PaperPlaneTilt,
        module: 'webhooks',
        demo: false,
      },
    ],
  },
  {
    labelKey: 'administration',
    entries: [
      {
        href: '/app/administration/people',
        labelKey: 'people',
        icon: ShieldCheck,
        module: 'identity',
        demo: false,
      },
      {
        href: '/app/administration/classifications',
        labelKey: 'classifications',
        icon: Books,
        module: 'financial',
        demo: false,
      },
      {
        href: '/app/administration/workspace',
        labelKey: 'workspace',
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
      labelKey: group.labelKey,
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
