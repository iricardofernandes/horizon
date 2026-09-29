import { API_KEY_SCOPES, SCOPE_ONLY_MODULES as PUBLISHED } from '@horizon/contracts'
import { expect, it } from 'vitest'

import { ApiKeyScopes, SCOPE_ONLY_MODULES } from '@/domain/value-objects/api-key-scopes'
import { RoleAssignments } from '@/domain/value-objects/role-assignments'

// The domain keeps its own copy, since it imports no contracts (ADR 0031).
it('names the same scope-only services as the published vocabulary', () => {
  expect([...SCOPE_ONLY_MODULES].sort()).toEqual([...PUBLISHED].sort())
})

it('accepts every published scope', () => {
  expect(ApiKeyScopes.create(API_KEY_SCOPES).isRight()).toBe(true)
})

it('lets anyone name a scope-only service, and still needs a role for a module', () => {
  const noRoles = RoleAssignments.empty()
  const scopeOnly = ApiKeyScopes.create(['agent:connect', 'files:write', 'knowledge:read'])
  if (scopeOnly.isLeft()) throw scopeOnly.value
  expect(scopeOnly.value.isGrantableBy(noRoles)).toBe(true)

  const withSales = ApiKeyScopes.create(['agent:connect', 'sales:read'])
  if (withSales.isLeft()) throw withSales.value
  expect(withSales.value.isGrantableBy(noRoles)).toBe(false)
  expect(withSales.value.modulesBeyond(noRoles)).toEqual(['sales'])
})
