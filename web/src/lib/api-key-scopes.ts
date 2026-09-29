/**
 * The scopes a person may put on an API key (ADR 0022, ADR 0064): read and write in each
 * module they hold a role in, plus the scope-only services, which carry no role and reach
 * only what the owning modules' roles allow. Identity refuses anything else; this only keeps
 * the dialog from offering it.
 */

/** Modules with roles, in the order `@horizon/contracts` declares them. */
const MODULES_WITH_ROLES = [
  'identity',
  'catalog',
  'inventory',
  'sales',
  'webhooks',
  'parties',
  'financial',
  'treasury',
  'ledger',
  'procurement',
  'fiscal',
  'crm',
  'reporting',
] as const

export const SCOPE_ONLY_NAMES = [
  'agent:connect',
  'files:read',
  'files:write',
  'knowledge:read',
] as const

export function grantableScopes(roles: readonly { module: string; role: string }[]): string[] {
  const held = new Set(roles.map((role) => role.module))
  return [
    ...MODULES_WITH_ROLES.filter((module) => held.has(module)).flatMap((module) => [
      `${module}:read`,
      `${module}:write`,
    ]),
    ...SCOPE_ONLY_NAMES,
  ]
}
