import { vi } from 'vitest'
import { SessionIssuer } from '@/application/services/session-issuer'
import type { Either } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Tenant } from '@/domain/entities/tenant'
import { RoleAssignments } from '@/domain/value-objects/role-assignments'
import { TenantName } from '@/domain/value-objects/tenant-name'
import { TenantSlug } from '@/domain/value-objects/tenant-slug'
import { Timezone } from '@/domain/value-objects/timezone'
import { makeUser } from '../factories/make-user'
import { InMemoryIdentityUnitOfWork } from '../repositories/in-memory-identity-unit-of-work'
import { InMemoryRefreshTokenFamiliesRepository } from '../repositories/in-memory-refresh-token-families-repository'

export function valid<L, T>(result: Either<L, T>): T {
  if (result.isLeft()) throw result.value
  return result.value
}

export const TEST_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA'

export async function identityContext() {
  let instant = new Date('2026-09-10T12:00:00Z')
  let nextSecret = 0
  const clock = { now: () => instant }
  const unitOfWork = new InMemoryIdentityUnitOfWork()
  const tenant = Tenant.create({
    name: valid(TenantName.create('Example Workspace')),
    slug: valid(TenantSlug.create('example')),
    timezone: valid(Timezone.create('America/Sao_Paulo')),
    createdAt: instant,
  })
  const tenantId = tenant.id.toString()
  const scope = unitOfWork.scope(tenantId)
  const user = makeUser({
    tenantId,
    createdAt: instant,
    roles: RoleAssignments.of([{ module: 'identity', role: 'owner' }]),
  })
  await scope.tenants.create(tenant)
  await scope.users.create(user)
  await unitOfWork.directory.register('example', tenantId)
  const hasher = {
    hash: vi.fn(async (_plaintext: string) => TEST_HASH),
    verify: vi.fn(async (_encoded: string, plaintext: string) => plaintext === 'correct'),
    verifyDummy: vi.fn(async () => {}),
  }
  const policy = {
    argon2: () => ({ memoryKib: 19456, timeCost: 2, parallelism: 1 }),
    session: () => ({ absoluteTtlSeconds: 3600, idleTtlSeconds: 600, reuseGraceMs: 1000 }),
    accessTokenTtlSeconds: () => 900,
    apiKeyEnvironment: () => 'test',
  }
  const secrets = {
    token: () => `refresh-${++nextSecret}`,
    alphanumeric: (length: number) => String(++nextSecret).padStart(length, 'A'),
    keyMaterial: () => 'subject-key-material',
    identifier: () => new UniqueEntityID().toString(),
  }
  const families = new InMemoryRefreshTokenFamiliesRepository()
  const denylist = {
    revoke: vi.fn(async (_jti: string, _expiresAt: Date) => {}),
    revokeSubject: vi.fn(async (_subject: string, _until: Date) => {}),
    check: async () => 'allowed' as const,
    checkSubject: async () => 'allowed' as const,
  }
  const signer = {
    mint: vi.fn(async () => ({
      token: 'access-token',
      jti: 'access-id',
      kid: 'signing-key',
      issuedAt: instant,
      expiresAt: new Date(instant.getTime() + 900000),
    })),
    verify: async (): Promise<never> => {
      throw new Error('Unused token verification')
    },
    jwks: () => [],
    activeKid: () => 'signing-key',
  }
  const sessions = new SessionIssuer(
    signer,
    families,
    { digest: (value) => `digest:${value}` },
    { seal: (_secret, plaintext) => plaintext, open: (_secret, ciphertext) => ciphertext },
    secrets,
    policy,
  )
  return {
    unitOfWork,
    scope,
    tenant,
    tenantId,
    user,
    hasher,
    policy,
    secrets,
    families,
    denylist,
    sessions,
    signer,
    clock,
    actor: { type: 'system' as const, id: null },
    advance: (milliseconds: number) => {
      instant = new Date(instant.getTime() + milliseconds)
    },
  }
}
