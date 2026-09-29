import { type Either, left, right } from '@/core/either'
import { ValueObject } from '@/core/entities/value-object'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { RoleAssignments } from './role-assignments'

/**
 * `<module>:<action>`, with `action` one of `read` or `write` (ADR 0022).
 *
 * The action axis is coarse on purpose. ADR 0022 requires a key's scopes to be a subset
 * of what its issuer can grant, and ADR 0023 forbids identity from expanding a role into
 * permissions — so "what the issuer can grant" has to be answerable from the opaque
 * `{ module, role }` pairs identity actually holds. It is: **the modules the issuer has
 * any role in**. Identity gates reach, the owning module gates precision, and neither
 * needs the other's table.
 *
 * A key therefore also carries its issuer's role pairs, and is re-evaluated against the
 * issuer's *current* pairs on every use — revoking someone's access narrows the keys they
 * already minted, which is the property the subset rule exists to guarantee.
 */
export const SCOPE_ACTIONS = ['read', 'write', 'connect'] as const
export type ScopeAction = (typeof SCOPE_ACTIONS)[number]

/**
 * Services reached by scope only (ADR 0064): they hold no roles, so a key may name them
 * whatever its issuer holds, and they carry no role into a token. What they reach is still
 * decided by the owning modules' roles. Which scope names are legal is the HTTP boundary's
 * question, answered by `@horizon/contracts`; an equality test keeps this list the same.
 */
export const SCOPE_ONLY_MODULES = ['agent', 'files', 'knowledge'] as const

const SCOPE_PATTERN = /^(?<module>[a-z][a-z0-9-]*):(?<action>read|write|connect)$/

export class ApiKeyScopes extends ValueObject<{ readonly values: readonly string[] }> {
  static create(raw: readonly string[]): Either<InvalidInputError, ApiKeyScopes> {
    if (raw.length === 0)
      return left(new InvalidInputError('/scopes', 'at least one scope is required'))
    if (raw.length > 50) return left(new InvalidInputError('/scopes', 'at most 50 scopes'))

    const invalid = raw.find((scope) => !SCOPE_PATTERN.test(scope))
    if (invalid !== undefined)
      return left(
        new InvalidInputError(
          '/scopes',
          `"${invalid}" is not a <module>:read, <module>:write or <module>:connect scope`,
        ),
      )

    return right(new ApiKeyScopes({ values: [...new Set(raw)].sort() }))
  }

  get values(): readonly string[] {
    return this.props.values
  }

  contains(scope: string): boolean {
    return this.props.values.includes(scope)
  }

  /** The distinct modules with roles these scopes reach into; scope-only services excluded. */
  get modules(): readonly string[] {
    const scopeOnly: readonly string[] = SCOPE_ONLY_MODULES
    return [...new Set(this.props.values.map((scope) => ApiKeyScopes.moduleOf(scope)))].filter(
      (module) => !scopeOnly.includes(module),
    )
  }

  /**
   * Could a holder of these role assignments mint this key? True when every module the
   * scopes reach is a module the issuer has some role in.
   */
  isGrantableBy(roles: RoleAssignments): boolean {
    return this.modules.every((module) => roles.hasAnyIn(module))
  }

  /** The modules that put the key beyond its issuer — named, so a rejection can say why. */
  modulesBeyond(roles: RoleAssignments): readonly string[] {
    return this.modules.filter((module) => !roles.hasAnyIn(module))
  }

  private static moduleOf(scope: string): string {
    return scope.slice(0, scope.indexOf(':'))
  }

  protected componentsOf(): readonly unknown[] {
    return this.props.values
  }
}
