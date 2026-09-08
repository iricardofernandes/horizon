import { z } from 'zod'

/**
 * Role *names* per module — and deliberately nothing more (ADR 0023).
 *
 * Authorization in Horizon is module-scoped and two-dimensional: an independent role per
 * module, so full admin in `catalog` implies nothing whatsoever in `sales`. An
 * assignment is a `{ module, role }` pair.
 *
 * What this package publishes is the set of *valid names*, so `identity` can mint a
 * well-formed token. What it deliberately does **not** publish is what any role permits:
 * each module owns the static `role → permissions` map for its own subjects and
 * validates the claim independently on arrival.
 *
 * That split is the point. `identity` stores opaque pairs and cannot expand them, so
 * compromising it yields role *names*, not an expanded permission set — expansion
 * happens in the module that owns the subject.
 */

export const MODULES = ['identity', 'catalog', 'inventory', 'sales', 'webhooks'] as const

export const moduleNameSchema = z.enum(MODULES)
export type ModuleName = z.infer<typeof moduleNameSchema>

/**
 * Roles are static and declared here — not editable per tenant.
 *
 * Tenant-configurable roles are the expected ERP feature and a permanent liability:
 * permission checks become unanalysable and no test can enumerate the reachable states.
 * The whole permission surface of the system is readable from this file plus five
 * per-module maps, in a few minutes. A role change is a deployment, not a support action.
 */
export const ROLES = {
  identity: ['owner', 'admin', 'member'],
  catalog: ['admin', 'editor', 'viewer'],
  inventory: ['admin', 'operator', 'viewer'],
  sales: ['admin', 'representative', 'viewer'],
  webhooks: ['admin', 'viewer'],
} as const satisfies Record<ModuleName, readonly string[]>

export type RolesByModule = typeof ROLES
export type RoleOf<M extends ModuleName> = RolesByModule[M][number]

export const roleAssignmentSchema = z.discriminatedUnion('module', [
  z.object({ module: z.literal('identity'), role: z.enum(ROLES.identity) }),
  z.object({ module: z.literal('catalog'), role: z.enum(ROLES.catalog) }),
  z.object({ module: z.literal('inventory'), role: z.enum(ROLES.inventory) }),
  z.object({ module: z.literal('sales'), role: z.enum(ROLES.sales) }),
  z.object({ module: z.literal('webhooks'), role: z.enum(ROLES.webhooks) }),
])

export type RoleAssignment = z.infer<typeof roleAssignmentSchema>

/**
 * `<module>:<subject>:<action>` — `sales:order:confirm`.
 *
 * The format is published so every module's permission identifiers are recognisable and
 * greppable; the identifiers themselves are the owning module's business.
 */
export const permissionIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/,
    'must be <module>:<subject>:<action>, lowercase',
  )

/** Is this a role the named module actually declares? */
export function isValidRole(module: ModuleName, role: string): boolean {
  return (ROLES[module] as readonly string[]).includes(role)
}
