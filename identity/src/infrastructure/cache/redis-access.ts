import { createHash, randomBytes } from 'node:crypto'
import type Redis from 'ioredis'
import {
  type Challenge,
  type ChallengePurpose,
  MfaChallenges,
  MfaLockout,
  type SessionMeta,
  SessionRegistry,
} from '@/application/ports/mfa'
import type { AuthMethod } from '@/domain/mfa/mfa-policy'

const segment = (value: string): string => Buffer.from(value).toString('base64url')
const digest = (token: string) => createHash('sha256').update(token).digest('base64url')

const keys = {
  challenge: (token: string) => `identity:mfa:challenge:${digest(token)}`,
  webauthn: (accountId: string) => `identity:mfa:webauthn:${segment(accountId)}`,
  failures: (accountId: string) => `identity:mfa:failures:${segment(accountId)}`,
  locked: (accountId: string) => `identity:mfa:locked:${segment(accountId)}`,
  meta: (tenantId: string, familyId: string) =>
    `identity:refresh:{${segment(tenantId)}}:meta:${segment(familyId)}`,
  tokens: (tenantId: string, familyId: string) =>
    `identity:refresh:{${segment(tenantId)}}:tokens:${segment(familyId)}`,
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/

const CONSUME = `
local value = redis.call('GET', KEYS[1])
if not value then return false end
redis.call('DEL', KEYS[1])
return value
`

/** Challenges between two steps of signing in, and passkey challenges of a signed-in person. */
export class RedisMfaChallenges extends MfaChallenges {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: Readonly<Record<ChallengePurpose, number>> = {
      login: 300,
      enrollment: 600,
    },
  ) {
    super()
  }

  async issue(accountId: string, purpose: ChallengePurpose) {
    const token = randomBytes(32).toString('base64url')
    const ttl = this.ttlSeconds[purpose]
    const challenge: Challenge = { accountId, purpose, webauthn: null }
    await this.redis.set(keys.challenge(token), JSON.stringify(challenge), 'EX', ttl)
    return { token, expiresAt: new Date(Date.now() + ttl * 1000) }
  }

  async resolve(token: string): Promise<Challenge | null> {
    if (!TOKEN.test(token)) return null
    const value = await this.redis.get(keys.challenge(token))
    return value ? (JSON.parse(value) as Challenge) : null
  }

  async setWebauthn(token: string, webauthn: string): Promise<void> {
    const current = await this.resolve(token)
    if (!current) return
    await this.redis.set(
      keys.challenge(token),
      JSON.stringify({ ...current, webauthn }),
      'KEEPTTL',
      'XX',
    )
  }

  async consume(token: string): Promise<Challenge | null> {
    if (!TOKEN.test(token)) return null
    const value = await this.redis.eval(CONSUME, 1, keys.challenge(token))
    return typeof value === 'string' ? (JSON.parse(value) as Challenge) : null
  }

  async rememberWebauthn(accountId: string, challenge: string): Promise<void> {
    await this.redis.set(keys.webauthn(accountId), challenge, 'EX', 300)
  }

  async takeWebauthn(accountId: string): Promise<string | null> {
    const value = await this.redis.eval(CONSUME, 1, keys.webauthn(accountId))
    return typeof value === 'string' ? value : null
  }
}

const FAIL = `
local failures = redis.call('INCR', KEYS[1])
if failures == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if failures >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return {failures, 1}
end
return {failures, 0}
`

/**
 * Five wrong second factors in fifteen minutes lock the account's second factor for fifteen
 * minutes. A Redis error propagates, so the check fails closed.
 */
export class RedisMfaLockout extends MfaLockout {
  constructor(
    private readonly redis: Redis,
    private readonly limit = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockMs = 15 * 60 * 1000,
  ) {
    super()
  }

  async isLocked(accountId: string): Promise<boolean> {
    return (await this.redis.exists(keys.locked(accountId))) === 1
  }

  async fail(accountId: string) {
    const [failures, locked] = (await this.redis.eval(
      FAIL,
      2,
      keys.failures(accountId),
      keys.locked(accountId),
      this.windowMs,
      this.limit,
      this.lockMs,
    )) as [number, number]
    return { locked: locked === 1, failures }
  }

  async clear(accountId: string): Promise<void> {
    await this.redis.del(keys.failures(accountId))
  }
}

interface StoredMeta {
  familyId: string
  tenantId: string
  userId: string
  device: string
  ipPrefix: string | null
  amr: AuthMethod[]
  authTime: string
  createdAt: string
  lastUsedAt: string
}

/**
 * Each session's metadata and the access tokens it issued, beside its refresh family and
 * with the same absolute deadline (ADR 0020). The tokens are a sorted set by expiry, so the
 * live ones are a range read.
 */
export class RedisSessionRegistry extends SessionRegistry {
  constructor(private readonly redis: Redis) {
    super()
  }

  async open(meta: SessionMeta, deadline: Date): Promise<void> {
    const stored: StoredMeta = {
      ...meta,
      amr: [...meta.amr],
      authTime: meta.authTime.toISOString(),
      createdAt: meta.createdAt.toISOString(),
      lastUsedAt: meta.lastUsedAt.toISOString(),
    }
    await this.redis.set(
      keys.meta(meta.tenantId, meta.familyId),
      JSON.stringify(stored),
      'PXAT',
      deadline.getTime(),
    )
  }

  async find(tenantId: string, familyId: string): Promise<SessionMeta | null> {
    const value = await this.redis.get(keys.meta(tenantId, familyId))
    if (!value) return null
    const stored = JSON.parse(value) as StoredMeta
    return {
      ...stored,
      authTime: new Date(stored.authTime),
      createdAt: new Date(stored.createdAt),
      lastUsedAt: new Date(stored.lastUsedAt),
    }
  }

  private async update(tenantId: string, familyId: string, change: Partial<StoredMeta>) {
    const key = keys.meta(tenantId, familyId)
    const value = await this.redis.get(key)
    if (!value) return
    await this.redis.set(key, JSON.stringify({ ...JSON.parse(value), ...change }), 'KEEPTTL', 'XX')
  }

  touch(tenantId: string, familyId: string, now: Date): Promise<void> {
    return this.update(tenantId, familyId, { lastUsedAt: now.toISOString() })
  }

  reauthenticate(tenantId: string, familyId: string, amr: readonly AuthMethod[], authTime: Date) {
    return this.update(tenantId, familyId, { amr: [...amr], authTime: authTime.toISOString() })
  }

  async recordToken(tenantId: string, familyId: string, jti: string, expiresAt: Date) {
    const key = keys.tokens(tenantId, familyId)
    await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', Date.now())
      .zadd(key, expiresAt.getTime(), jti)
      .pexpireat(key, expiresAt.getTime())
      .exec()
  }

  async liveTokens(tenantId: string, familyId: string, now: Date) {
    const entries = await this.redis.zrangebyscore(
      keys.tokens(tenantId, familyId),
      now.getTime(),
      '+inf',
      'WITHSCORES',
    )
    const tokens: { jti: string; expiresAt: Date }[] = []
    for (let index = 0; index < entries.length; index += 2)
      tokens.push({ jti: entries[index] ?? '', expiresAt: new Date(Number(entries[index + 1])) })
    return tokens
  }

  async forget(tenantId: string, familyId: string): Promise<void> {
    await this.redis.del(keys.meta(tenantId, familyId), keys.tokens(tenantId, familyId))
  }
}
