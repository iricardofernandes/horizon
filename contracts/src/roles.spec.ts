import { describe, expect, it } from 'vitest'

import { isValidRole, MODULES, ROLES, roleAssignmentSchema } from './roles'

describe('role assignments', () => {
  it('accepts a role the module declares', () => {
    expect(roleAssignmentSchema.safeParse({ module: 'catalog', role: 'editor' }).success).toBe(true)
  })

  it('rejects a role that belongs to a different module', () => {
    // Authorization is two-dimensional: `operator` is an inventory role and means
    // nothing in catalog. Accepting it would silently grant an undefined permission set
    // (ADR 0023).
    expect(roleAssignmentSchema.safeParse({ module: 'catalog', role: 'operator' }).success).toBe(
      false,
    )
  })

  it('rejects an unknown module', () => {
    expect(roleAssignmentSchema.safeParse({ module: 'payroll', role: 'admin' }).success).toBe(false)
  })

  it('declares roles for every module, with no duplicates', () => {
    for (const module of MODULES) {
      const roles = ROLES[module]
      expect(roles.length).toBeGreaterThan(0)
      expect(new Set(roles).size).toBe(roles.length)
    }
  })

  it('agrees with isValidRole', () => {
    expect(isValidRole('sales', 'representative')).toBe(true)
    expect(isValidRole('sales', 'operator')).toBe(false)
  })

  it('declares fiscal roles without granting one module another module role', () => {
    expect(roleAssignmentSchema.safeParse({ module: 'fiscal', role: 'issuer' }).success).toBe(true)
    expect(roleAssignmentSchema.safeParse({ module: 'fiscal', role: 'buyer' }).success).toBe(false)
  })

  it('declares CRM roles, where a representative is not an admin', () => {
    expect(roleAssignmentSchema.safeParse({ module: 'crm', role: 'manager' }).success).toBe(true)
    expect(roleAssignmentSchema.safeParse({ module: 'crm', role: 'buyer' }).success).toBe(false)
    expect(isValidRole('crm', 'representative')).toBe(true)
  })

  it('declares reporting roles, where an analyst is not an admin', () => {
    expect(roleAssignmentSchema.safeParse({ module: 'reporting', role: 'analyst' }).success).toBe(
      true,
    )
    expect(roleAssignmentSchema.safeParse({ module: 'reporting', role: 'manager' }).success).toBe(
      false,
    )
  })
})
