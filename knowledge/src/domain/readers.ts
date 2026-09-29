/**
 * Who may find a chunk (ADR 0067): whoever may read its attachment in `files/`, that is,
 * whoever holds a read role in the owning module. This table is `files/`'s own (`permits`),
 * copied as the platform copies its guards, and a test keeps the two equal.
 */
export const ATTACHING_MODULES = ['parties', 'procurement', 'financial', 'sales', 'crm'] as const
export type AttachingModule = (typeof ATTACHING_MODULES)[number]

export const READ_ROLES: Readonly<Record<AttachingModule, readonly string[]>> = {
  parties: ['admin', 'editor', 'viewer'],
  procurement: ['admin', 'buyer', 'approver', 'viewer'],
  financial: ['admin', 'operator', 'viewer'],
  sales: ['admin', 'representative', 'viewer'],
  crm: ['admin', 'manager', 'representative', 'viewer'],
}

export interface RoleAssignment {
  readonly module: string
  readonly role: string
}

/**
 * The modules whose attachments the caller can read: a read role there, and, for a key's
 * token, a scope that reaches the module too (ADR 0064), as `scopeReads` answers it.
 */
export function readableModules(
  roles: readonly RoleAssignment[],
  scopeReads: (module: AttachingModule) => boolean = () => true,
): AttachingModule[] {
  return ATTACHING_MODULES.filter(
    (module) =>
      roles.some((held) => held.module === module && READ_ROLES[module].includes(held.role)) &&
      scopeReads(module),
  )
}

/**
 * The screen a record is read on, so a citation can be followed. Screens that open one
 * record from the address take `?open=`; the others list their records.
 */
export function screenOf(module: string, recordType: string, recordId: string): string {
  const id = encodeURIComponent(recordId)
  switch (`${module}/${recordType}`) {
    case 'parties/party':
      return '/app/registrations/parties'
    case 'procurement/purchase-order':
      return '/app/purchasing/orders'
    case 'financial/receivable':
      return `/app/finance/receivables?open=${id}`
    case 'financial/payable':
      return `/app/finance/payables?open=${id}`
    case 'sales/service-order':
      return '/app/sales/service-orders'
    case 'crm/opportunity':
      return `/app/crm/pipeline?open=${id}`
    default:
      return '/app'
  }
}
