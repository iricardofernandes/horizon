import { describe, expect, it } from 'vitest'

import { MODULES } from '../roles'
import {
  API_KEY_SCOPES,
  accessTokenScopesSchema,
  apiKeyScopeSchema,
  apiKeyTokenResponseSchema,
  SCOPE_ONLY_MODULES,
  scopeAllows,
} from './api-keys'

describe('the API key scope vocabulary (ADR 0064)', () => {
  it('reads and writes every module with roles', () => {
    for (const module of MODULES) {
      expect(API_KEY_SCOPES).toContain(`${module}:read`)
      expect(API_KEY_SCOPES).toContain(`${module}:write`)
    }
  })

  it('names the modules without roles by scope only, with no duplicates', () => {
    expect(API_KEY_SCOPES).toContain('agent:connect')
    expect(API_KEY_SCOPES).toContain('files:write')
    expect(API_KEY_SCOPES).toContain('knowledge:read')
    for (const module of SCOPE_ONLY_MODULES) expect(MODULES).not.toContain(module)
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length)
  })

  it('refuses an unknown module or action', () => {
    expect(apiKeyScopeSchema.safeParse('payroll:read').success).toBe(false)
    expect(apiKeyScopeSchema.safeParse('sales:approve').success).toBe(false)
    expect(apiKeyScopeSchema.safeParse('agent:read').success).toBe(false)
  })
})

describe('scopeAllows', () => {
  it('leaves a signed-in person to their roles', () => {
    expect(scopeAllows(undefined, 'sales', 'DELETE')).toBe(true)
  })

  it('lets a read scope read and never write', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get'])
      expect(scopeAllows(['catalog:read'], 'catalog', method)).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(scopeAllows(['catalog:read'], 'catalog', method)).toBe(false)
  })

  it('lets a write scope read and write', () => {
    expect(scopeAllows(['catalog:write'], 'catalog', 'GET')).toBe(true)
    expect(scopeAllows(['catalog:write'], 'catalog', 'POST')).toBe(true)
  })

  it('never lets one module scope reach another module', () => {
    expect(scopeAllows(['catalog:write'], 'sales', 'GET')).toBe(false)
    expect(scopeAllows([], 'sales', 'GET')).toBe(false)
  })

  it('reads files only with files:read and writes them only with files:write', () => {
    expect(scopeAllows(['files:read'], 'files', 'GET')).toBe(true)
    expect(scopeAllows(['files:read'], 'files', 'POST')).toBe(false)
    expect(scopeAllows(['files:write'], 'files', 'PUT')).toBe(true)
  })
})

describe('the key token claim and response', () => {
  it('bounds the scp claim', () => {
    expect(accessTokenScopesSchema.safeParse(['sales:read']).success).toBe(true)
    expect(accessTokenScopesSchema.safeParse(Array(61).fill('sales:read')).success).toBe(false)
  })

  it('answers no roles', () => {
    const response = {
      tenantId: '01a0b6b8-0000-7000-8000-000000000001',
      apiKeyId: '01a0b6b8-0000-7000-8000-000000000002',
      accessToken: 'x'.repeat(40),
      expiresAt: '2026-09-29T12:00:00.000Z',
      scopes: ['sales:read'],
    }
    expect(apiKeyTokenResponseSchema.safeParse(response).success).toBe(true)
    expect(apiKeyTokenResponseSchema.safeParse({ ...response, roles: [] }).success).toBe(false)
  })
})
