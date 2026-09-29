import { expect, it } from 'vitest'
import { left, right } from '@/core/either'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import type { AccessTokenSigner, KeyGrant } from '../ports/access-token-signer'
import type { ApiKeyRateLimiter, RateVerdict } from '../ports/api-key-rate-limiter'
import type { AuthenticateApiKeyUseCase } from './authenticate-api-key'
import { ExchangeApiKeyUseCase, KEY_TOKEN_TTL_SECONDS } from './exchange-api-key'

const tenantId = '00000000-0000-4000-8000-000000000001'
const fiscalScopes = ['parties:read', 'identity:read', 'catalog:read']
const issuerRoles = [
  { module: 'identity', role: 'owner' },
  { module: 'identity', role: 'fiscal-reader' },
  { module: 'parties', role: 'fiscal-reader' },
  { module: 'catalog', role: 'viewer' },
  { module: 'sales', role: 'representative' },
  { module: 'financial', role: 'admin' },
]

function exchange(
  grants: { scopes: string[]; roles: typeof issuerRoles },
  verdict: RateVerdict | 'unavailable' = { allowed: true },
) {
  const minted: { claims?: unknown; grant?: KeyGrant } = {}
  const authenticate = {
    execute: async () => right({ apiKeyId: 'key-1', issuedBy: 'user-1', ...grants }),
  } as unknown as AuthenticateApiKeyUseCase
  const limiter = {
    consume: async () => {
      if (verdict === 'unavailable') throw new Error('redis down')
      return verdict
    },
  } as unknown as ApiKeyRateLimiter
  const signer = {
    mint: async (claims: unknown, _now: Date, _context: unknown, grant: KeyGrant) => {
      minted.claims = claims
      minted.grant = grant
      return { token: 'signed-token', expiresAt: new Date('2026-09-29T12:01:00Z') }
    },
  } as unknown as AccessTokenSigner
  const clock = { now: () => new Date('2026-09-29T12:00:00Z') }
  return { useCase: new ExchangeApiKeyUseCase(authenticate, limiter, signer, clock), minted }
}

it('narrows the issuer roles to the modules the key reaches, and carries its scopes', async () => {
  const subject = exchange({ scopes: ['sales:read', 'agent:connect'], roles: issuerRoles })
  const result = await subject.useCase.forKey({ tenantId, presented: 'key' })
  expect(result.isRight()).toBe(true)
  expect(result.value).toMatchObject({
    tenantId,
    apiKeyId: 'key-1',
    accessToken: 'signed-token',
    scopes: ['sales:read', 'agent:connect'],
  })
  expect(subject.minted.claims).toEqual({
    subject: 'api-key:key-1',
    tenantId,
    roles: [{ module: 'sales', role: 'representative' }],
  })
  expect(subject.minted.grant).toEqual({
    scopes: ['sales:read', 'agent:connect'],
    issuer: 'user-1',
    ttlSeconds: KEY_TOKEN_TTL_SECONDS,
  })
})

it('refuses a key over its limit with the seconds to wait', async () => {
  const subject = exchange(
    { scopes: ['sales:read'], roles: issuerRoles },
    { allowed: false, retryAfterSeconds: 17 },
  )
  const result = await subject.useCase.forKey({ tenantId, presented: 'key' })
  expect(result.isLeft()).toBe(true)
  expect(result.value).toMatchObject({ name: 'ApiKeyRateLimitedError', retryAfterSeconds: 17 })
  expect(subject.minted.claims).toBeUndefined()
})

it('refuses rather than skip the count when the limiter is unavailable', async () => {
  const subject = exchange({ scopes: ['sales:read'], roles: issuerRoles }, 'unavailable')
  const result = await subject.useCase.forKey({ tenantId, presented: 'key' })
  expect(result.value).toMatchObject({ name: 'RateLimitUnavailableError' })
})

it('passes an authentication refusal through without counting or minting', async () => {
  const authenticate = {
    execute: async () => left(new InvalidCredentialsError()),
  } as unknown as AuthenticateApiKeyUseCase
  let counted = false
  const limiter = {
    consume: async () => {
      counted = true
      return { allowed: true }
    },
  } as unknown as ApiKeyRateLimiter
  const useCase = new ExchangeApiKeyUseCase(authenticate, limiter, {} as AccessTokenSigner, {
    now: () => new Date(),
  })
  const result = await useCase.forKey({ tenantId, presented: 'wrong' })
  expect(result.value).toBeInstanceOf(InvalidCredentialsError)
  expect(counted).toBe(false)
})

it('mints the fiscal reader token with three fixed roles and its scopes', async () => {
  const subject = exchange({ scopes: [...fiscalScopes, 'sales:write'], roles: issuerRoles })
  const result = await subject.useCase.forFiscalReader({ tenantId, presented: 'service-key' })
  expect(result.isRight()).toBe(true)
  expect(subject.minted.claims).toEqual({
    subject: 'api-key:key-1',
    tenantId,
    roles: [
      { module: 'parties', role: 'fiscal-reader' },
      { module: 'identity', role: 'fiscal-reader' },
      { module: 'catalog', role: 'viewer' },
    ],
  })
  // The ordinary access-token lifetime, which the fiscal worker's cache relies on.
  expect(subject.minted.grant).toEqual({
    scopes: ['catalog:read', 'identity:read', 'parties:read'],
    issuer: 'user-1',
  })
})

it('refuses a fiscal key missing one scope or dedicated role', async () => {
  for (const grants of [
    { scopes: ['parties:read', 'identity:read'], roles: issuerRoles },
    { scopes: fiscalScopes, roles: issuerRoles.filter((role) => role.module !== 'parties') },
    {
      scopes: fiscalScopes,
      roles: issuerRoles.map((role) =>
        role.module === 'catalog' ? { module: 'catalog', role: 'admin' } : role,
      ),
    },
  ]) {
    const result = await exchange(grants).useCase.forFiscalReader({
      tenantId,
      presented: 'service-key',
    })
    expect(result.value).toMatchObject({ message: 'Fiscal service key lacks required access' })
  }
})
