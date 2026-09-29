/**
 * The command palette (Phase 66): screens, actions and search results in one list. Screens
 * and actions are offered only when the roles allow them; each module still decides.
 */
import { type NavigationEntry, type RoleAssignment, visibleNavigation } from './navigation'

export type PaletteAction = {
  id: string
  /** Key inside `palette.actions`. */
  labelKey: string
  href: string
  module: string
  roles: readonly string[]
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'register-party',
    labelKey: 'registerParty',
    href: '/app/registrations/parties',
    module: 'parties',
    roles: ['admin', 'editor'],
  },
  {
    id: 'new-receivable',
    labelKey: 'newReceivable',
    href: '/app/finance/receivables',
    module: 'financial',
    roles: ['admin', 'operator'],
  },
  {
    id: 'new-payable',
    labelKey: 'newPayable',
    href: '/app/finance/payables',
    module: 'financial',
    roles: ['admin', 'operator'],
  },
  {
    id: 'new-requisition',
    labelKey: 'newRequisition',
    href: '/app/purchasing/requisitions',
    module: 'procurement',
    roles: ['admin', 'buyer'],
  },
  {
    id: 'new-opportunity',
    labelKey: 'newOpportunity',
    href: '/app/crm/pipeline',
    module: 'crm',
    roles: ['admin', 'manager', 'representative'],
  },
  {
    id: 'import-file',
    labelKey: 'importFile',
    href: '/app/administration/imports',
    module: 'parties',
    roles: ['admin'],
  },
  {
    id: 'bill-contracts',
    labelKey: 'billContracts',
    href: '/app/sales/billing',
    module: 'sales',
    roles: ['admin', 'representative'],
  },
]

export function allowedActions(roles: readonly RoleAssignment[]): PaletteAction[] {
  return PALETTE_ACTIONS.filter((action) =>
    roles.some((role) => role.module === action.module && action.roles.includes(role.role)),
  )
}

export function paletteScreens(roles: readonly RoleAssignment[], hostedDemo: boolean) {
  return visibleNavigation(roles, hostedDemo).flatMap((group) => group.entries)
}

const folded = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Whether every word of the query is in the label, ignoring case and accents. */
export function matches(label: string, query: string): boolean {
  const words = folded(query).split(/\s+/).filter(Boolean)
  const haystack = folded(label)
  return words.every((word) => haystack.includes(word))
}

export type PaletteOption =
  | { group: 'screens'; key: string; label: string; href: string; entry: NavigationEntry }
  | { group: 'actions'; key: string; label: string; href: string }
  | { group: 'results'; key: string; label: string; detail: string | null; href: string }
  | { group: 'documents'; key: string; label: string; detail: string | null; href: string }

/** Moves the active option with the arrows, wrapping at both ends. */
export function nextIndex(
  current: number,
  count: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
) {
  if (count === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
  return current <= 0 ? count - 1 : current - 1
}
