import { randomBytes, randomUUID } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  Controller,
  type INestApplication,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import Redis from 'ioredis'
import request from 'supertest'

import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import {
  IdempotencyInterceptor,
  IdempotencySignup,
  SkipIdempotency,
} from '@/infrastructure/http/idempotency-interceptor'
import {
  type IdempotencyClaim,
  type IdempotencyRequest,
  IdempotencyStore,
} from '@/infrastructure/http/idempotency-store'

@Controller('idempotency-probe')
class ProbeController {
  writes = 0

  @Post()
  @IdempotencySignup()
  create() {
    return { apiKey: `sensitive-key-${++this.writes}` }
  }

  @Post('exchange')
  @SkipIdempotency()
  exchange() {
    return { accessToken: `sensitive-access-token-${++this.writes}` }
  }

  @Post('failure')
  @IdempotencySignup()
  fail(): never {
    throw new BadRequestException('The operation did not execute')
  }
}

function operation(overrides: Partial<IdempotencyRequest> = {}): IdempotencyRequest {
  return {
    tenantId: randomUUID(),
    principal: randomUUID(),
    endpoint: 'POST /api-keys',
    key: randomUUID(),
    body: { name: 'Integration', scopes: ['catalog:read'] },
    ...overrides,
  }
}

async function claim(
  store: IdempotencyStore,
  input: IdempotencyRequest,
): Promise<IdempotencyClaim> {
  const result = await store.begin(input)
  if (result.state !== 'started') throw new Error('Expected a new idempotency claim')
  return result
}

describe('HTTP idempotency with Redis', () => {
  let redis: Redis
  let store: IdempotencyStore
  let app: INestApplication
  const secret = randomBytes(32).toString('hex')

  beforeAll(async () => {
    const url = process.env.REDIS_URL
    if (!url) throw new Error('REDIS_URL must be provided by Testcontainers')
    redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    })
    await redis.connect()
    store = new IdempotencyStore(redis, new AesGcmSecretBox(), secret)
    const module = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = module.createNestApplication()
    app.useGlobalInterceptors(new IdempotencyInterceptor(store, new Reflector()))
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
    redis?.disconnect()
  })

  it('stores encrypted responses for 24 hours and rejects changed bodies and requests in flight', async () => {
    const input = operation()
    const owned = await claim(store, input)
    await expect(store.begin(input)).rejects.toBeInstanceOf(ConflictException)
    const response = { statusCode: 201, body: { apiKey: 'plaintext-must-never-reach-redis' } }
    const deadline = await redis.pexpiretime(owned.storageKey)
    expect(await redis.pttl(owned.storageKey)).toBeGreaterThan(86_399_000)
    await store.complete(owned, response)
    const persisted = await redis.get(owned.storageKey)
    expect(persisted).not.toContain('plaintext-must-never-reach-redis')
    expect(await redis.pexpiretime(owned.storageKey)).toBe(deadline)
    const replay = await store.begin({
      ...input,
      body: { scopes: ['catalog:read'], name: 'Integration' },
    })
    expect(replay).toEqual({ state: 'replay', response })
    await expect(store.begin({ ...input, body: { name: 'Changed' } })).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('isolates tenant, principal and concrete endpoint and rejects ciphertext moved between scopes', async () => {
    const input = operation()
    const original = await claim(store, input)
    const response = { statusCode: 201, body: { apiKey: randomBytes(32).toString('hex') } }
    await store.complete(original, response)
    const anotherTenant = await claim(store, { ...input, tenantId: randomUUID() })
    const otherPrincipal = randomUUID()
    const anotherUser = await claim(store, { ...input, principal: otherPrincipal })
    const anotherEndpoint = await claim(store, {
      ...input,
      endpoint: 'POST /api-keys/other/rotate',
    })
    expect(
      new Set(
        [original, anotherTenant, anotherUser, anotherEndpoint].map((value) => value.storageKey),
      ).size,
    ).toBe(4)
    const serialized = await redis.get(original.storageKey)
    if (!serialized) throw new Error('Missing completed response')
    await redis.set(anotherUser.storageKey, serialized, 'KEEPTTL')
    await expect(store.begin({ ...input, principal: otherPrincipal })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
  })

  it('accepts one concurrent claimant and only its owner can release or complete the record', async () => {
    const input = operation()
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => store.begin(input)))
    const accepted = results.filter((result) => result.status === 'fulfilled')
    expect(accepted).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(11)
    const owned = accepted[0]?.value
    if (owned?.state !== 'started') throw new Error('Missing accepted claim')
    await store.release({ ...owned, owner: randomUUID() })
    await expect(store.begin(input)).rejects.toBeInstanceOf(ConflictException)
    await store.release(owned)
    const replacement = await claim(store, input)
    await store.release(owned)
    await expect(
      store.complete(owned, { statusCode: 200, body: 'wrong-owner' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    await store.complete(replacement, { statusCode: 201, body: 'correct-owner' })
    await store.release(replacement)
    expect(await store.begin(input)).toEqual({
      state: 'replay',
      response: { statusCode: 201, body: 'correct-owner' },
    })
  })

  it('expires records and rejects completion by the owner of an expired claim', async () => {
    const expiring = new IdempotencyStore(redis, new AesGcmSecretBox(), secret, { ttlSeconds: 1 })
    const input = operation()
    const original = await claim(expiring, input)
    await expect.poll(() => redis.exists(original.storageKey), { timeout: 3000 }).toBe(0)
    const replacement = await claim(expiring, input)
    await expect(
      expiring.complete(original, { statusCode: 200, body: 'stale' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    await expiring.complete(replacement, { statusCode: 201, body: 'new' })
    expect(await expiring.begin(input)).toEqual({
      state: 'replay',
      response: { statusCode: 201, body: 'new' },
    })
  })

  it('replays the exact HTTP status and body without executing the write twice', async () => {
    const key = randomUUID()
    const body = {
      slug: randomUUID(),
      owner: { email: 'owner@example.com', password: 'strong-password' },
    }
    const server = app.getHttpServer()
    const first = await request(server)
      .post('/idempotency-probe')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201)
    const replay = await request(server)
      .post('/idempotency-probe')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201)
    expect(replay.body).toEqual(first.body)
    await request(server)
      .post('/idempotency-probe')
      .set('Idempotency-Key', key)
      .send({ ...body, name: 'changed' })
      .expect(409)
    const otherCredential = await request(server)
      .post('/idempotency-probe')
      .set('Idempotency-Key', key)
      .send({ ...body, owner: { ...body.owner, password: 'different-password' } })
      .expect(201)
    expect(otherCredential.body).not.toEqual(first.body)
  })

  it('keeps the header optional and excludes login and refresh credential exchanges explicitly', async () => {
    const server = app.getHttpServer()
    const withoutKey = await request(server).post('/idempotency-probe').send({}).expect(201)
    const secondWithoutKey = await request(server).post('/idempotency-probe').send({}).expect(201)
    expect(secondWithoutKey.body).not.toEqual(withoutKey.body)
    const key = randomUUID()
    const first = await request(server)
      .post('/idempotency-probe/exchange')
      .set('Idempotency-Key', key)
      .send({})
      .expect(201)
    const second = await request(server)
      .post('/idempotency-probe/exchange')
      .set('Idempotency-Key', key)
      .send({})
      .expect(201)
    expect(second.body).not.toEqual(first.body)
  })

  it('releases failed operations so a retry can run, and fails closed if Redis is unavailable', async () => {
    const key = randomUUID()
    const body = {
      slug: randomUUID(),
      owner: { email: 'owner@example.com', password: 'strong-password' },
    }
    for (let attempt = 0; attempt < 2; attempt++)
      await request(app.getHttpServer())
        .post('/idempotency-probe/failure')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(400)
    const disconnected = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    try {
      const unavailable = new IdempotencyStore(disconnected, new AesGcmSecretBox(), secret)
      await expect(unavailable.begin(operation())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      )
    } finally {
      disconnected.disconnect()
    }
  })

  it('retains the claim when saving a completed operation fails, preventing a duplicate write', async () => {
    const key = randomUUID()
    const body = {
      slug: randomUUID(),
      owner: { email: 'owner@example.com', password: 'strong-password' },
    }
    const controller = app.get(ProbeController)
    const writesBefore = controller.writes
    const completion = vi
      .spyOn(store, 'complete')
      .mockRejectedValueOnce(new ServiceUnavailableException())
    try {
      await request(app.getHttpServer())
        .post('/idempotency-probe')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(503)
      await request(app.getHttpServer())
        .post('/idempotency-probe')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(409)
      expect(controller.writes).toBe(writesBefore + 1)
    } finally {
      completion.mockRestore()
    }
  })
})
