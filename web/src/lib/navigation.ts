import type { Icon } from '@phosphor-icons/react'
import {
  AddressBook,
  Bank,
  BookOpen,
  Books,
  Briefcase,
  Calculator,
  CalendarCheck,
  CalendarDots,
  ChartBar,
  CheckSquareOffset,
  ClipboardText,
  FileArrowDown,
  FileText,
  Gear,
  GearSix,
  HandCoins,
  Invoice,
  Kanban,
  Key,
  Lifebuoy,
  ListChecks,
  Package,
  PaperPlaneTilt,
  Receipt,
  Repeat,
  SealCheck,
  ShieldCheck,
  ShoppingCart,
  TrendUp,
  Truck,
  UploadSimple,
  UsersThree,
  Van,
  Warehouse,
  WebhooksLogo,
  Wrench,
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
    labelKey: 'crm',
    entries: [
      { href: '/app/crm/pipeline', labelKey: 'pipeline', icon: Kanban, module: 'crm', demo: false },
      {
        href: '/app/crm/accounts',
        labelKey: 'accounts',
        icon: AddressBook,
        module: 'crm',
        demo: false,
      },
      {
        href: '/app/crm/agenda',
        labelKey: 'agenda',
        icon: CalendarDots,
        module: 'crm',
        demo: false,
      },
      {
        href: '/app/crm/forecast',
        labelKey: 'forecast',
        icon: TrendUp,
        module: 'crm',
        demo: false,
      },
      {
        href: '/app/crm/settings',
        labelKey: 'crmSettings',
        icon: GearSix,
        module: 'crm',
        demo: false,
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
        href: '/app/sales/approvals',
        labelKey: 'quoteApprovals',
        icon: SealCheck,
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
      {
        href: '/app/sales/deliveries',
        labelKey: 'shipments',
        icon: Van,
        module: 'sales',
        demo: false,
      },
      {
        href: '/app/sales/service-orders',
        labelKey: 'serviceOrders',
        icon: Wrench,
        module: 'sales',
        demo: false,
      },
      {
        href: '/app/sales/contracts',
        labelKey: 'contracts',
        icon: Repeat,
        module: 'sales',
        demo: false,
      },
      {
        href: '/app/sales/billing',
        labelKey: 'contractBilling',
        icon: CalendarCheck,
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
    labelKey: 'purchasing',
    entries: [
      {
        href: '/app/purchasing/requisitions',
        labelKey: 'requisitions',
        icon: ClipboardText,
        module: 'procurement',
        demo: false,
      },
      {
        href: '/app/purchasing/approvals',
        labelKey: 'approvals',
        icon: SealCheck,
        module: 'procurement',
        demo: false,
      },
      {
        href: '/app/purchasing/orders',
        labelKey: 'purchaseOrders',
        icon: Truck,
        module: 'procurement',
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
      {
        href: '/app/inventory/operations',
        labelKey: 'operations',
        icon: Truck,
        module: 'inventory',
        demo: false,
      },
      {
        href: '/app/inventory/reports',
        labelKey: 'reports',
        icon: ChartBar,
        module: 'inventory',
        demo: false,
      },
      {
        href: '/app/inventory/tracking',
        labelKey: 'tracking',
        icon: Package,
        module: 'inventory',
        demo: false,
      },
      {
        href: '/app/inventory/production',
        labelKey: 'production',
        icon: Gear,
        module: 'inventory',
        demo: false,
      },
      {
        href: '/app/inventory/structure',
        labelKey: 'structure',
        icon: Books,
        module: 'catalog',
        demo: false,
      },
    ],
  },
  {
    labelKey: 'fiscal',
    entries: [
      {
        href: '/app/fiscal/documents',
        labelKey: 'fiscalDocuments',
        icon: Receipt,
        module: 'fiscal',
        demo: false,
      },
      {
        href: '/app/fiscal/preview',
        labelKey: 'fiscalPreview',
        icon: Calculator,
        module: 'fiscal',
        demo: false,
      },
      {
        href: '/app/fiscal/service-profiles',
        labelKey: 'fiscalServiceProfiles',
        icon: Briefcase,
        module: 'fiscal',
        demo: false,
      },
      {
        href: '/app/fiscal/inbound',
        labelKey: 'fiscalInbound',
        icon: FileArrowDown,
        module: 'fiscal',
        demo: false,
      },
      {
        href: '/app/fiscal/support',
        labelKey: 'fiscalSupport',
        icon: Lifebuoy,
        module: 'fiscal',
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
        href: '/app/administration/imports',
        labelKey: 'imports',
        icon: UploadSimple,
        // Parties, Catalog, Inventory and Financial each import; the screen offers only the
        // ones the user administers (Phase 64).
        module: null,
        demo: false,
      },
      {
        href: '/app/settings/security',
        labelKey: 'security',
        icon: ShieldCheck,
        // Everyone's own second factors and sessions (Phase 67).
        module: null,
        demo: false,
      },
      {
        href: '/app/jobs',
        labelKey: 'jobs',
        icon: ListChecks,
        // Imports, exports and runs across modules: each source is asked only when the
        // user holds its role (Phase 66).
        module: null,
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
