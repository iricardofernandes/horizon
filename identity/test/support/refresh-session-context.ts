import { vi } from 'vitest'
import type { TokenDenylist } from '@/application/ports/token-denylist'
import type { TenantScope, UnitOfWork } from '@/application/ports/unit-of-work'
import { SessionIssuer } from '@/application/services/session-issuer'
import { RefreshSessionUseCase } from '@/application/use-cases/refresh-session'
import type { User } from '@/domain/entities/user'
import type { AuditLogRepository } from '@/domain/repositories/audit-log-repository'
import type { OutboxRepository } from '@/domain/repositories/outbox-repository'
import type { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'
import { makeRefreshTokenFamily } from '../factories/make-refresh-token-family'
import { makeUser } from '../factories/make-user'
import { InMemoryRefreshTokenFamiliesRepository } from '../repositories/in-memory-refresh-token-families-repository'

function unused(): never {
  throw new Error('Unexpected repository operation')
}

export async function refreshSessionContext(
  options: {
    families?: RefreshTokenFamiliesRepository
    denylist?: TokenDenylist
    createdAt?: Date
  } = {},
) {
  const user = makeUser()
  const tenantId = user.claims().tenantId
  const createdAt = options.createdAt ?? new Date('2026-09-10T12:00:00Z')
  let now = createdAt
  let storedUser: User | null = user
  let tokenNumber = 0
  const families = options.families ?? new InMemoryRefreshTokenFamiliesRepository()
  const denylist = {
    revoke: vi.fn<TokenDenylist['revoke']>(async (jti, expiresAt) => {
      await options.denylist?.revoke(jti, expiresAt)
    }),
    revokeSubject: vi.fn<TokenDenylist['revokeSubject']>(async (subject, until) => {
      await options.denylist?.revokeSubject(subject, until)
    }),
    check: async () => 'allowed' as const,
    checkSubject: async () => 'allowed' as const,
  }
  const family = makeRefreshTokenFamily({
    tenantId,
    userId: user.id.toString(),
    currentDigest: 'digest:initial',
    createdAt,
  })
  await families.create(family, 60)
  const audit = {
    append: vi.fn<AuditLogRepository['append']>(),
    walk: unused,
    lastSequence: unused,
  }
  const outbox = { publish: vi.fn<OutboxRepository['publish']>() }
  const scope: TenantScope = {
    tenantId,
    get tenants() {
      return unused()
    },
    get apiKeys() {
      return unused()
    },
    get dataSubjectKeys() {
      return unused()
    },
    users: {
      findById: async (id) => (storedUser?.id.toString() === id ? storedUser : null),
      findByEmail: unused,
      create: unused,
      save: unused,
      list: unused,
      countActive: unused,
    },
    audit,
    outbox,
  }
  const unitOfWork: UnitOfWork = {
    async inTenant(id, work) {
      if (id !== tenantId) throw new Error('Unexpected tenant scope')
      return work(scope)
    },
  }
  const policy = {
    session: () => ({ absoluteTtlSeconds: 60, idleTtlSeconds: 10, reuseGraceMs: 1000 }),
    argon2: () => ({ memoryKib: 19456, timeCost: 2, parallelism: 1 }),
    accessTokenTtlSeconds: () => 900,
    apiKeyEnvironment: () => 'test',
  }
  const digest = { digest: (value: string) => `digest:${value}` }
  const secretBox = {
    seal: (secret: string, plaintext: string) => JSON.stringify([secret, plaintext]),
    open: vi.fn((secret: string, sealed: string): string | null => {
      const [key, plaintext] = JSON.parse(sealed)
      return key === secret ? plaintext : null
    }),
  }
  const signer = {
    mint: vi.fn(async () => ({
      token: 'access',
      jti: 'jti',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 900000),
      kid: 'test',
    })),
    verify: unused,
    jwks: () => [],
    activeKid: () => 'test',
  }
  const secrets = {
    token: () => `replacement-${++tokenNumber}`,
    alphanumeric: unused,
    keyMaterial: unused,
    identifier: unused,
  }
  const sessions = new SessionIssuer(signer, families, digest, secretBox, secrets, policy)
  const sut = new RefreshSessionUseCase(
    unitOfWork,
    families,
    denylist,
    digest,
    secretBox,
    sessions,
    policy,
    { now: () => now },
  )
  const request = { tenantId, familyId: family.id.toString(), refreshToken: 'initial' }
  return {
    sut,
    request,
    families,
    denylist,
    family,
    user,
    audit,
    outbox,
    signer,
    secretBox,
    advance: (milliseconds: number) => {
      now = new Date(createdAt.getTime() + milliseconds)
    },
    removeUser: () => {
      storedUser = null
    },
  }
}
