import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { z } from 'zod'

import { AppModule } from '@/main/app.module'
import { readEnvironment } from '@/main/environment'
import { IdentityRuntime } from '@/main/identity-runtime'

let app: INestApplication
let runtime: IdentityRuntime
let directory: string
const password = 'correct-horse-battery-staple'
const sessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  familyId: z.uuid(),
  jti: z.uuid(),
  accessTokenExpiresAt: z.string(),
})

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'horizon-identity-http-'))
  await mkdir(join(directory, 'public'))
  const pair = generateKeyPairSync('ed25519')
  const privatePath = join(directory, 'private.pem')
  const keyPath = join(directory, 'blind-index.key')
  await Promise.all([
    writeFile(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    }),
    writeFile(
      join(directory, 'public', 'ed25519-http-test-public.pem'),
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
    ),
    writeFile(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 }),
  ])
  const config = readEnvironment({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_PRIVATE_KEY_PATH: privatePath,
    JWT_PUBLIC_KEYS_DIR: join(directory, 'public'),
    JWT_ACTIVE_KID: 'http-test',
    BLIND_INDEX_KEY_PATH: keyPath,
  })
  const module = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile()
  app = module.createNestApplication({ logger: false })
  await app.init()
  runtime = app.get(IdentityRuntime)
})

afterAll(async () => {
  await app?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function signupInput() {
  return {
    name: 'HTTP Tenant',
    slug: `http-${randomBytes(6).toString('hex')}`,
    timezone: 'UTC',
    owner: { name: 'Tenant Owner', email: 'owner@example.test', password },
  }
}

async function tenant() {
  const input = signupInput()
  const created = await request(app.getHttpServer()).post('/auth/signup').send(input).expect(201)
  const ids = z.object({ tenantId: z.uuid(), ownerId: z.uuid() }).parse(created.body)
  const session = await login(input.slug, input.owner.email)
  return { ...ids, ...session, slug: input.slug }
}

async function login(tenantSlug: string, email: string) {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ tenantSlug, email, password })
    .expect(200)
  return sessionSchema.parse(response.body)
}

async function member(owner: Awaited<ReturnType<typeof tenant>>) {
  const email = `member-${randomBytes(4).toString('hex')}@example.test`
  const created = await request(app.getHttpServer())
    .post('/users')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({
      email,
      name: 'Member Person',
      password,
      roles: [
        { module: 'identity', role: 'member' },
        { module: 'catalog', role: 'admin' },
      ],
    })
    .expect(201)
  return {
    userId: z.object({ userId: z.uuid() }).parse(created.body).userId,
    email,
    ...(await login(owner.slug, email)),
  }
}

it('serves public JWKS and health without disclosing private material', async () => {
  const jwks = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200)
  expect(jwks.body.keys).toHaveLength(1)
  expect(jwks.body.keys[0]).toMatchObject({ kid: 'http-test', alg: 'EdDSA', crv: 'Ed25519' })
  expect(jwks.body.keys[0]).not.toHaveProperty('d')
  await request(app.getHttpServer()).get('/health/live').expect(200)
  await request(app.getHttpServer()).get('/health/ready').expect(200)
})

it('publishes request schemas, authentication and explicit outage exceptions in OpenAPI', () => {
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
  const signup = document.paths['/auth/signup']?.post?.requestBody
  expect(signup).toMatchObject({
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['name', 'slug', 'timezone', 'owner'],
        },
      },
    },
  })
  expect(document.paths['/me']?.get).toMatchObject({
    'x-revocation-store-outage': 'allow-read',
    security: [{ bearer: [] }],
  })
  expect(document.paths['/audit/verify']?.get).not.toHaveProperty('x-revocation-store-outage')
})

it('authenticates locally and scopes user reads to the verified tenant despite spoofed headers', async () => {
  const first = await tenant()
  const second = await tenant()
  const users = await request(app.getHttpServer())
    .get('/users')
    .set('Authorization', `Bearer ${first.accessToken}`)
    .set('x-tenant-id', second.tenantId)
    .set('x-user-id', second.ownerId)
    .expect(200)

  expect(users.body.data).toHaveLength(1)
  expect(users.body.data[0]).toMatchObject({ id: first.ownerId, tenantId: first.tenantId })
  expect(users.body.data[0]).not.toHaveProperty('passwordHash')
  await request(app.getHttpServer())
    .get(`/users/${second.ownerId}`)
    .set('Authorization', `Bearer ${first.accessToken}`)
    .expect(404)
  await request(app.getHttpServer())
    .get('/users')
    .set('x-tenant-id', first.tenantId)
    .set('x-user-id', first.ownerId)
    .expect(401)
})

it('returns RFC 9457 validation and authentication errors with request correlation', async () => {
  const invalid = await request(app.getHttpServer())
    .post('/auth/signup')
    .set('x-request-id', 'http-test-validation')
    .send({ ...signupInput(), timezone: '' })
    .expect(422)
  expect(invalid.headers['content-type']).toContain('application/problem+json')
  expect(invalid.headers['x-request-id']).toBe('http-test-validation')
  expect(invalid.body).toMatchObject({
    status: 422,
    requestId: 'http-test-validation',
    violations: expect.any(Array),
  })
  const unauthorized = await request(app.getHttpServer()).get('/me').expect(401)
  expect(unauthorized.body.type).toBe('https://horizon.dev/problems/invalid-access-token')
  expect(unauthorized.headers['www-authenticate']).toBe('Bearer')
})

it('applies idempotency to signup and refuses changed bodies under the same key', async () => {
  const input = signupInput()
  const key = randomBytes(16).toString('hex')
  const first = await request(app.getHttpServer())
    .post('/auth/signup')
    .set('Idempotency-Key', key)
    .send(input)
    .expect(201)
  const replay = await request(app.getHttpServer())
    .post('/auth/signup')
    .set('Idempotency-Key', key)
    .send(input)
    .expect(201)
  expect(replay.body).toEqual(first.body)
  await request(app.getHttpServer())
    .post('/auth/signup')
    .set('Idempotency-Key', key)
    .send({ ...input, name: 'Changed name' })
    .expect(409)
  await request(app.getHttpServer()).post('/auth/signup').send(input).expect(409)
})

it('returns the same replacement to concurrent refreshes and revokes both credentials on logout', async () => {
  const owner = await tenant()
  const input = {
    tenantId: owner.tenantId,
    familyId: owner.familyId,
    refreshToken: owner.refreshToken,
  }
  const responses = await Promise.all([
    request(app.getHttpServer()).post('/auth/refresh').send(input).expect(200),
    request(app.getHttpServer()).post('/auth/refresh').send(input).expect(200),
  ])
  const first = sessionSchema.parse(responses[0]?.body)
  const second = sessionSchema.parse(responses[1]?.body)
  expect(first.refreshToken).toBe(second.refreshToken)
  expect(first.refreshToken).not.toBe(owner.refreshToken)
  await request(app.getHttpServer())
    .post('/auth/logout')
    .set('Authorization', `Bearer ${first.accessToken}`)
    .send({ familyId: owner.familyId })
    .expect(204)
  await request(app.getHttpServer())
    .get('/me')
    .set('Authorization', `Bearer ${first.accessToken}`)
    .expect(401)
  await request(app.getHttpServer())
    .post('/auth/refresh')
    .send({ ...input, refreshToken: first.refreshToken })
    .expect(401)
})

it('keeps catalog administrators from Identity administration and rejects body tenant injection', async () => {
  const owner = await tenant()
  const user = await member(owner)
  await request(app.getHttpServer())
    .get('/me')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .expect(200)
  await request(app.getHttpServer())
    .get('/users')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .expect(403)
  await request(app.getHttpServer())
    .post('/users')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ tenantId: owner.tenantId, email: 'extra@example.test', name: 'Extra Person', password })
    .expect(422)
})

it('issues API keys once, respects issuer scope, and revokes them immediately', async () => {
  const owner = await tenant()
  const key = await request(app.getHttpServer())
    .post('/api-keys')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Integration', scopes: ['identity:read'] })
    .expect(201)
  await request(app.getHttpServer())
    .post('/auth/api-key')
    .send({ tenantId: owner.tenantId, presented: key.body.token })
    .expect(200)
  await request(app.getHttpServer())
    .post('/api-keys')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Overprivileged', scopes: ['sales:read'] })
    .expect(403)
  await request(app.getHttpServer())
    .delete(`/api-keys/${key.body.apiKeyId}`)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .expect(204)
  await request(app.getHttpServer())
    .post('/auth/api-key')
    .send({ tenantId: owner.tenantId, presented: key.body.token })
    .expect(401)
})

it('exports without credentials and erases a subject while preserving audit verification', async () => {
  const owner = await tenant()
  const user = await member(owner)
  const exported = await request(app.getHttpServer())
    .get(`/data-subjects/${user.userId}/export`)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .expect(200)
  expect(exported.body.user.email).toBe(user.email)
  expect(exported.body.user).not.toHaveProperty('passwordHash')
  await request(app.getHttpServer())
    .delete(`/data-subjects/${user.userId}`)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .expect(204)
  await request(app.getHttpServer())
    .get('/me')
    .set('Authorization', `Bearer ${user.accessToken}`)
    .expect(401)
  const chain = await request(app.getHttpServer())
    .get('/audit/verify')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .expect(200)
  expect(chain.body.intact).toBe(true)
})

it('allows only the explicitly read-only route during a Redis outage', async () => {
  const owner = await tenant()
  runtime.redis.disconnect()
  try {
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200)
    await request(app.getHttpServer())
      .get('/audit/verify')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(503)
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Unavailable', scopes: ['identity:read'] })
      .expect(503)
  } finally {
    await runtime.redis.connect()
  }
})
