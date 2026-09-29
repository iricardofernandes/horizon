import { describe, expect, it } from 'vitest'
import { grantableScopes } from './api-key-scopes'

describe('grantableScopes', () => {
  it('offers read and write only in modules the person holds a role in', () => {
    const scopes = grantableScopes([
      { module: 'sales', role: 'viewer' },
      { module: 'catalog', role: 'editor' },
      { module: 'catalog', role: 'viewer' },
    ])
    expect(scopes.slice(0, 4)).toEqual([
      'catalog:read',
      'catalog:write',
      'sales:read',
      'sales:write',
    ])
    expect(scopes).not.toContain('financial:read')
  })

  it('always offers the scope-only services', () => {
    expect(grantableScopes([])).toEqual([
      'agent:connect',
      'files:read',
      'files:write',
      'knowledge:read',
    ])
  })
})
