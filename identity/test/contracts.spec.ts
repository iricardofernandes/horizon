import { isValidRole, MODULES, ROLES, roleAssignmentSchema } from '@horizon/contracts'
import { describe, expect, it } from 'vitest'

/**
 * Identity mints tokens carrying `{ module, role }` pairs for every module in the
 * system, so it is the one module that consumes the published role names for *all* of
 * them (ADR 0023).
 *
 * These are contract tests, not unit tests of identity's own logic. They exist so that
 * removing or renaming a role in `@horizon/contracts` fails here — loudly, at build
 * time — rather than at runtime when a token turns out to carry a role the receiving
 * module no longer recognises.
 */
describe('published role contract', () => {
  it('declares roles for every module identity can mint for', () => {
    // If a module is added to the system, identity must be able to mint for it.
    expect([...MODULES].sort()).toEqual(
      ['catalog', 'identity', 'inventory', 'sales', 'webhooks'].sort(),
    )
  })

  it('still declares the identity roles this module assigns', () => {
    expect([...ROLES.identity]).toContain('owner')
    expect([...ROLES.identity]).toContain('admin')
    expect([...ROLES.identity]).toContain('member')
  })

  it("refuses an assignment pairing a module with another module's role", () => {
    // The two-dimensional model: a role name means nothing outside its own module, so
    // identity must not be able to mint `{ module: catalog, role: operator }`.
    expect(roleAssignmentSchema.safeParse({ module: 'catalog', role: 'operator' }).success).toBe(
      false,
    )
    expect(isValidRole('catalog', 'operator')).toBe(false)
  })

  it('accepts a well-formed assignment', () => {
    expect(roleAssignmentSchema.safeParse({ module: 'inventory', role: 'operator' }).success).toBe(
      true,
    )
  })
})
