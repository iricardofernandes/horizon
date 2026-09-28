import { claimsOf } from './federation'
import type { RoleAssignment } from './navigation'
import { authenticatedFetch } from './session'

/**
 * Who each actor id is, when the person may read Identity's users; otherwise nothing, and
 * the screen shows ids. Server-only: it asks Identity with the person's own token.
 */
export async function actorNames(
  roles: readonly RoleAssignment[],
): Promise<Record<string, string>> {
  const readsUsers = roles.some(
    (role) => role.module === 'identity' && ['owner', 'admin'].includes(role.role),
  )
  if (!readsUsers) return {}
  try {
    const response = await authenticatedFetch('/identity/users?limit=100', {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return {}
    const body = (await response.json()) as { data?: { id?: unknown; name?: unknown }[] }
    return Object.fromEntries(
      (body.data ?? [])
        .filter((user) => typeof user.id === 'string' && typeof user.name === 'string')
        .map((user) => [user.id as string, user.name as string]),
    )
  } catch {
    return {}
  }
}

export function rolesOf(token: string | null): RoleAssignment[] {
  return claimsOf(token).roles
}
