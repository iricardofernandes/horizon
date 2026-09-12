import { createHmac, randomUUID } from 'node:crypto'
import { ConflictException, ServiceUnavailableException } from '@nestjs/common'
import type Redis from 'ioredis'
import { z } from 'zod'
import { redisKeys } from '@/infrastructure/cache/redis-keys'
import type { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'

export interface IdempotencyRequest {
  readonly tenantId: string
  readonly principal: string
  readonly endpoint: string
  readonly key: string
  readonly body: unknown
}

export interface IdempotentResponse {
  readonly statusCode: number
  readonly body: unknown
}

export interface IdempotencyClaim {
  readonly state: 'started'
  readonly storageKey: string
  readonly owner: string
  readonly fingerprint: string
}

export type IdempotencyResult =
  | IdempotencyClaim
  | { readonly state: 'replay'; readonly response: IdempotentResponse }

const CLAIM = `
local stored = redis.call('GET', KEYS[1])
if not stored then
  redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[3])
  return {1}
end
local record = cjson.decode(stored)
if record.fingerprint ~= ARGV[2] then return {2} end
if record.state == 'pending' then return {3} end
if record.state ~= 'completed' then return {5} end
return {4, record.response}
`

const COMPLETE = `
local stored = redis.call('GET', KEYS[1])
if not stored then return 0 end
local record = cjson.decode(stored)
if record.state ~= 'pending' or record.owner ~= ARGV[1] then return 0 end
if record.fingerprint ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'XX', 'KEEPTTL')
return 1
`

const RELEASE = `
local stored = redis.call('GET', KEYS[1])
if not stored then return 0 end
local record = cjson.decode(stored)
if record.state ~= 'pending' or record.owner ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`

const responseSchema = z.object({
  statusCode: z.number().int().min(100).max(599),
  body: z.unknown(),
})

/** JSON object key order does not change the meaning of a retried request body. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Idempotency bodies must be JSON values')
  return serialized
}

/**
 * Optional HTTP retry protection (ADR 0028), scoped to both tenant and principal.
 *
 * Opted-in requests fail closed on Redis failure: a write whose retry protection is
 * unavailable is a write that may be applied twice. A pending claim survives a failed
 * completion write, because the domain transaction may already have committed and
 * releasing the claim would license a duplicate.
 */
export class IdempotencyStore {
  private readonly ttlMs: number

  constructor(
    private readonly redis: Redis,
    private readonly secretBox: AesGcmSecretBox,
    private readonly secret: string,
    options: { ttlSeconds?: number } = {},
  ) {
    const ttlSeconds = options.ttlSeconds ?? 86_400
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new Error('Idempotency TTL must be a positive integer')
    if (secret.length < 32) throw new Error('Idempotency requires a strong service secret')
    this.ttlMs = ttlSeconds * 1000
  }

  async begin(request: IdempotencyRequest): Promise<IdempotencyResult> {
    const storageKey = redisKeys.idempotency(
      this.digest(
        'scope',
        JSON.stringify([request.tenantId, request.principal, request.endpoint, request.key]),
      ),
    )
    const fingerprint = this.digest('body', canonicalJson(request.body))
    const owner = randomUUID()
    const pending = JSON.stringify({ state: 'pending', owner, fingerprint })
    const result = await this.evaluate(CLAIM, storageKey, pending, fingerprint, this.ttlMs)
    if (!Array.isArray(result)) throw new ServiceUnavailableException('Invalid idempotency state')
    if (result[0] === 1) return { state: 'started', storageKey, owner, fingerprint }
    if (result[0] === 2)
      throw new ConflictException('Idempotency-Key was already used with a different request body')
    if (result[0] === 3)
      throw new ConflictException('A request with this Idempotency-Key is still in progress')
    if (result[0] !== 4 || typeof result[1] !== 'string')
      throw new ServiceUnavailableException('Invalid idempotency state')
    const plaintext = this.secretBox.open(this.responseSecret(storageKey, fingerprint), result[1])
    if (plaintext === null) throw new ServiceUnavailableException('Invalid idempotency response')
    try {
      const response = responseSchema.parse(JSON.parse(plaintext))
      return { state: 'replay', response: { statusCode: response.statusCode, body: response.body } }
    } catch {
      throw new ServiceUnavailableException('Invalid idempotency response')
    }
  }

  async complete(claim: IdempotencyClaim, response: IdempotentResponse): Promise<void> {
    const sealed = this.secretBox.seal(
      this.responseSecret(claim.storageKey, claim.fingerprint),
      JSON.stringify(response),
    )
    const completed = JSON.stringify({
      state: 'completed',
      fingerprint: claim.fingerprint,
      response: sealed,
    })
    const saved = await this.evaluate(
      COMPLETE,
      claim.storageKey,
      claim.owner,
      claim.fingerprint,
      completed,
    )
    if (saved !== 1) throw new ServiceUnavailableException('Idempotency ownership was lost')
  }

  async release(claim: IdempotencyClaim): Promise<void> {
    await this.evaluate(RELEASE, claim.storageKey, claim.owner)
  }

  private digest(purpose: string, value: string): string {
    return createHmac('sha256', this.secret).update(`${purpose}\0${value}`).digest('hex')
  }

  private responseSecret(storageKey: string, fingerprint: string): string {
    // Ciphertext copied between tenants, principals or request bodies cannot open.
    return this.digest('response', `${storageKey}\0${fingerprint}`)
  }

  private async evaluate(
    script: string,
    key: string,
    ...args: (string | number)[]
  ): Promise<unknown> {
    try {
      return await this.redis.eval(script, 1, key, ...args)
    } catch {
      throw new ServiceUnavailableException('Idempotency storage is unavailable')
    }
  }
}
