import { ApiKey } from '@/domain/entities/api-key'
import { ApiKeyScopes } from '@/domain/value-objects/api-key-scopes'

export function makeApiKey(overrides: Partial<Parameters<typeof ApiKey.create>[0]> = {}) {
  const scopes = ApiKeyScopes.create(['identity:read'])
  if (scopes.isLeft()) throw scopes.value
  return ApiKey.create({
    tenantId: 'tenant',
    issuedBy: 'issuer',
    name: 'Integration',
    environment: 'test',
    prefix: 'A'.repeat(24),
    secretHash: 'hashed-secret',
    scopes: scopes.value,
    createdAt: new Date('2026-09-10T12:00:00Z'),
    ...overrides,
  })
}
