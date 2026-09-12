import { randomBytes, randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { trace } from '@opentelemetry/api'
import { NodeSDK, tracing } from '@opentelemetry/sdk-node'
import request from 'supertest'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { z } from 'zod'
import { redisKeys } from '@/infrastructure/cache/redis-keys'
import { AppModule } from '@/main/app.module'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { readEnvironment } from '@/main/environment'
import { FakeIdentity, type TestRoleAssignment } from './support/access-tokens'

// Started for its context manager: without one there is no active span for an audit
// entry to borrow a trace id from, and the correlation assertion below would be vacuous.
const telemetry = new NodeSDK({
  spanProcessors: [new tracing.SimpleSpanProcessor(new tracing.InMemorySpanExporter())],
  logRecordProcessors: [],
  metricReaders: [],
})
let app: INestApplication
let runtime: CatalogRuntime
let identity: FakeIdentity

beforeAll(async () => {
  telemetry.start()
  identity = await FakeIdentity.start()
  const config = readEnvironment({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWKS_URL: identity.jwksUrl,
    IDEMPOTENCY_SECRET: randomBytes(32).toString('hex'),
    // Absent on purpose: the relay is exercised by outbox.e2e-spec.ts, and a poller
    // running under the HTTP suite would publish rows these tests never assert on.
    DATABASE_RELAY_URL: undefined,
  })
  const module = await Test.createTestingModule({ imports: [AppModule.register(config)] }).compile()
  app = module.createNestApplication({ logger: false })
  await app.init()
  runtime = app.get(CatalogRuntime)
})

afterAll(async () => {
  await app?.close()
  await identity?.stop()
  await telemetry.shutdown()
})

async function tenant(
  roles: readonly TestRoleAssignment[] = [{ module: 'catalog', role: 'admin' }],
) {
  const tenantId = randomUUID()
  await runtime.database.provisionTenant(tenantId)
  const minted = await identity.mint({ tenantId, roles })
  return { tenantId, ...minted }
}

const authorized = (token: string) => ({ Authorization: `Bearer ${token}` })

async function unit(token: string, code = `U${randomBytes(2).toString('hex')}`) {
  const response = await request(app.getHttpServer())
    .post('/units')
    .set(authorized(token))
    .send({ code, name: 'Unit', decimalPlaces: 0 })
    .expect(201)
  return z.object({ unitId: z.uuid() }).parse(response.body).unitId
}

async function item(token: string, unitId: string, sku = `SKU-${randomBytes(4).toString('hex')}`) {
  const response = await request(app.getHttpServer())
    .post('/items')
    .set(authorized(token))
    .send({ kind: 'product', sku, name: 'Coffee', unitId, ncm: '09012100' })
    .expect(201)
  return z.object({ itemId: z.uuid() }).parse(response.body).itemId
}

it('serves health without a token and refuses everything else', async () => {
  await request(app.getHttpServer()).get('/health/live').expect(200)
  await request(app.getHttpServer()).get('/health/ready').expect(200)

  const anonymous = await request(app.getHttpServer()).get('/items').expect(401)
  expect(anonymous.headers['www-authenticate']).toBe('Bearer')
  expect(anonymous.headers['content-type']).toContain('application/problem+json')
  expect(anonymous.body).toMatchObject({
    type: 'https://horizon.dev/problems/invalid-access-token',
    status: 401,
  })
})

it('rejects tokens this service cannot verify against the published key set', async () => {
  const { tenantId } = await tenant()
  const unknownKey = await identity.mint({
    tenantId,
    roles: [{ module: 'catalog', role: 'admin' }],
    kid: 'retired-key',
  })
  await request(app.getHttpServer()).get('/items').set(authorized(unknownKey.token)).expect(401)

  // A token whose issuer names a different key than the one that signed it.
  const mismatchedIssuer = await identity.mint({
    tenantId,
    roles: [{ module: 'catalog', role: 'admin' }],
    issuer: 'horizon-identity-other',
  })
  await request(app.getHttpServer())
    .get('/items')
    .set(authorized(mismatchedIssuer.token))
    .expect(401)

  const expired = await identity.mint({
    tenantId,
    roles: [{ module: 'catalog', role: 'admin' }],
    ttlSeconds: 60,
    issuedAtOffsetSeconds: -3600,
  })
  await request(app.getHttpServer()).get('/items').set(authorized(expired.token)).expect(401)

  // Unsigned and symmetric tokens: `alg` is pinned, so neither is a near miss.
  const [header, payload] = expired.token.split('.')
  await request(app.getHttpServer())
    .get('/items')
    .set(authorized(`${header}.${payload}.`))
    .expect(401)
})

it('expands only Catalog roles, and only as far as the role allows', async () => {
  const admin = await tenant()
  const unitId = await unit(admin.token)

  const viewer = await identity.mint({
    tenantId: admin.tenantId,
    roles: [{ module: 'catalog', role: 'viewer' }],
  })
  await request(app.getHttpServer()).get('/items').set(authorized(viewer.token)).expect(200)
  const refused = await request(app.getHttpServer())
    .post('/items')
    .set(authorized(viewer.token))
    .send({ kind: 'product', sku: 'VIEWER-1', name: 'Coffee', unitId })
    .expect(403)
  expect(refused.body).toMatchObject({ status: 403 })

  const editor = await identity.mint({
    tenantId: admin.tenantId,
    roles: [{ module: 'catalog', role: 'editor' }],
  })
  await request(app.getHttpServer())
    .post('/items')
    .set(authorized(editor.token))
    .send({
      kind: 'product',
      sku: `EDITOR-${randomBytes(3).toString('hex')}`,
      name: 'Coffee',
      unitId,
    })
    .expect(201)
  // Structure is administrative: an editor fills the catalogue, it does not reshape it.
  await request(app.getHttpServer())
    .post('/units')
    .set(authorized(editor.token))
    .send({ code: 'EDT', name: 'Editor unit', decimalPlaces: 0 })
    .expect(403)

  // A role in another module grants nothing here, whatever it is called there.
  const outsider = await identity.mint({
    tenantId: admin.tenantId,
    roles: [
      { module: 'identity', role: 'owner' },
      { module: 'sales', role: 'admin' },
    ],
  })
  await request(app.getHttpServer()).get('/items').set(authorized(outsider.token)).expect(403)
})

it('takes the tenant from the verified claim and ignores any header that claims otherwise', async () => {
  const a = await tenant()
  const b = await tenant()
  const unitId = await unit(a.token)
  const itemId = await item(a.token, unitId)

  await request(app.getHttpServer())
    .post('/items')
    .set(authorized(a.token))
    .set('x-tenant-id', b.tenantId)
    .send({
      kind: 'service',
      sku: `SPOOF-${randomBytes(3).toString('hex')}`,
      name: 'Support',
      unitId,
    })
    .expect(201)

  const seenByB = await request(app.getHttpServer())
    .get('/items')
    .set(authorized(b.token))
    .expect(200)
  expect(seenByB.body.data).toHaveLength(0)

  const seenByA = await request(app.getHttpServer())
    .get('/items')
    .set(authorized(a.token))
    .expect(200)
  expect(seenByA.body.data.map((entry: { id: string }) => entry.id)).toContain(itemId)
})

it('creates, lists, pages and deactivates through the published surface', async () => {
  const admin = await tenant()
  const unitId = await unit(admin.token)
  const first = await item(admin.token, unitId, `PAGE-A-${randomBytes(3).toString('hex')}`)
  const second = await item(admin.token, unitId, `PAGE-B-${randomBytes(3).toString('hex')}`)

  const page = await request(app.getHttpServer())
    .get('/items?limit=1')
    .set(authorized(admin.token))
    .expect(200)
  expect(page.body.data).toHaveLength(1)
  expect(page.body.page.hasMore).toBe(true)
  expect(page.body.data[0]).toMatchObject({ id: first, kind: 'product', active: true })
  expect(page.body.data[0]).not.toHaveProperty('tenantId')

  const next = await request(app.getHttpServer())
    .get(`/items?limit=1&cursor=${encodeURIComponent(page.body.page.nextCursor)}`)
    .set(authorized(admin.token))
    .expect(200)
  expect(next.body.data[0].id).toBe(second)

  const priceListId = z.object({ priceListId: z.uuid() }).parse(
    (
      await request(app.getHttpServer())
        .post('/price-lists')
        .set(authorized(admin.token))
        .send({ name: `Base ${randomBytes(3).toString('hex')}`, currency: 'BRL' })
        .expect(201)
    ).body,
  ).priceListId
  await request(app.getHttpServer())
    .put(`/price-lists/${priceListId}/prices/${first}`)
    .set(authorized(admin.token))
    .send({ amount: '2590', currency: 'BRL' })
    .expect(204)

  const priceLists = await request(app.getHttpServer())
    .get('/price-lists')
    .set(authorized(admin.token))
    .expect(200)
  expect(priceLists.body.data[0].prices).toEqual([{ itemId: first, amount: '2590' }])

  await request(app.getHttpServer())
    .patch(`/items/${first}/deactivate`)
    .set(authorized(admin.token))
    .expect(204)
  const deactivated = await request(app.getHttpServer())
    .get('/items')
    .set(authorized(admin.token))
    .expect(200)
  expect(deactivated.body.data.find((entry: { id: string }) => entry.id === first).active).toBe(
    false,
  )
})

it('records the authenticated principal as the actor behind every write', async () => {
  const admin = await tenant()
  let requestTraceId = ''
  const created = await trace
    .getTracer('catalog.test')
    .startActiveSpan('test.request', async (span) => {
      requestTraceId = span.spanContext().traceId
      try {
        return await request(app.getHttpServer())
          .post('/units')
          .set(authorized(admin.token))
          .set('x-request-id', 'audit-correlation')
          .send({
            code: `A${randomBytes(2).toString('hex').toUpperCase()}`,
            name: 'Audited',
            decimalPlaces: 0,
          })
          .expect(201)
      } finally {
        span.end()
      }
    })

  const entries = await runtime.database.inTenant(admin.tenantId, (scope) =>
    scope.audit.walk(0, 10),
  )
  expect(entries).toHaveLength(1)
  expect(entries[0]?.toSnapshot()).toMatchObject({
    action: 'catalog.unit.created',
    actorType: 'user',
    actorId: admin.subject,
    subjectType: 'UnitOfMeasure',
    subjectId: z.object({ unitId: z.uuid() }).parse(created.body).unitId,
    // The same correlation id the client sent, the response echoed and the logs carry.
    requestId: 'audit-correlation',
  })
  // One trace from the caller's span to the audit row that records what it did.
  expect(entries[0]?.toSnapshot().traceId).toBe(requestTraceId)
})

it('maps every expected failure to its problem type without echoing the request', async () => {
  const admin = await tenant()
  const unitId = await unit(admin.token)
  const sku = `DUP-${randomBytes(3).toString('hex')}`
  await item(admin.token, unitId, sku)

  const conflict = await request(app.getHttpServer())
    .post('/items')
    .set(authorized(admin.token))
    .send({ kind: 'product', sku, name: 'Coffee', unitId })
    .expect(409)
  expect(conflict.body).toMatchObject({
    type: 'https://horizon.dev/problems/conflict',
    status: 409,
  })

  const invalid = await request(app.getHttpServer())
    .post('/items')
    .set(authorized(admin.token))
    .send({ kind: 'product', sku, name: 'Coffee', unitId, ncm: '123' })
    .expect(422)
  expect(invalid.body.type).toBe('https://horizon.dev/problems/invalid-input')
  expect(invalid.body.violations[0].pointer).toBe('/ncm')
  expect(JSON.stringify(invalid.body)).not.toContain(sku)

  const unknownField = await request(app.getHttpServer())
    .post('/units')
    .set(authorized(admin.token))
    .send({ code: 'XX', name: 'Extra', decimalPlaces: 0, tenantId: randomUUID() })
    .expect(422)
  expect(unknownField.body.violations[0].pointer).toBe('/tenantId')

  const missing = await request(app.getHttpServer())
    .put(`/price-lists/${randomUUID()}/prices/${randomUUID()}`)
    .set(authorized(admin.token))
    .send({ amount: '100', currency: 'BRL' })
    .expect(404)
  expect(missing.body.type).toBe('https://horizon.dev/problems/resource-not-found')

  // The dotted form an NCM code is written in is accepted and stored normalized.
  const dotted = await request(app.getHttpServer())
    .post('/items')
    .set(authorized(admin.token))
    .send({
      kind: 'product',
      sku: `NCM-${randomBytes(3).toString('hex')}`,
      name: 'Coffee',
      unitId,
      ncm: '0901.21.00',
    })
    .expect(201)
  const stored = await request(app.getHttpServer())
    .get('/items')
    .set(authorized(admin.token))
    .expect(200)
  expect(
    stored.body.data.find(
      (entry: { id: string }) =>
        entry.id === z.object({ itemId: z.uuid() }).parse(dotted.body).itemId,
    ).ncm,
  ).toBe('09012100')

  const badCursor = await request(app.getHttpServer())
    .get('/items?cursor=not-a-cursor')
    .set(authorized(admin.token))
    .expect(422)
  expect(badCursor.body.violations[0].pointer).toBe('/cursor')
})

it('replays an idempotent write and refuses the key for a different body', async () => {
  const admin = await tenant()
  const key = randomUUID()
  const body = {
    code: `I${randomBytes(2).toString('hex').toUpperCase()}`,
    name: 'Idempotent',
    decimalPlaces: 2,
  }

  const first = await request(app.getHttpServer())
    .post('/units')
    .set(authorized(admin.token))
    .set('Idempotency-Key', key)
    .send(body)
    .expect(201)
  const replay = await request(app.getHttpServer())
    .post('/units')
    .set(authorized(admin.token))
    .set('Idempotency-Key', key)
    // Key order is not meaning: the same body reordered is the same request.
    .send({ decimalPlaces: body.decimalPlaces, name: body.name, code: body.code })
    .expect(201)
  expect(replay.body).toEqual(first.body)

  await request(app.getHttpServer())
    .post('/units')
    .set(authorized(admin.token))
    .set('Idempotency-Key', key)
    .send({ ...body, name: 'Something else' })
    .expect(409)

  const units = await request(app.getHttpServer())
    .get('/units')
    .set(authorized(admin.token))
    .expect(200)
  expect(
    units.body.data.filter((entry: { code: string }) => entry.code === body.code),
  ).toHaveLength(1)
})

it('honours the revocation denylist Identity writes', async () => {
  const admin = await tenant()
  await request(app.getHttpServer()).get('/items').set(authorized(admin.token)).expect(200)

  await runtime.redis.set(redisKeys.deniedToken(admin.jti), '1', 'PX', 60_000)
  await request(app.getHttpServer()).get('/items').set(authorized(admin.token)).expect(401)
  await runtime.redis.del(redisKeys.deniedToken(admin.jti))

  await runtime.redis.set(redisKeys.deniedSubject(admin.subject), '1', 'PX', 60_000)
  await request(app.getHttpServer()).get('/items').set(authorized(admin.token)).expect(401)
  await runtime.redis.del(redisKeys.deniedSubject(admin.subject))
})

it('degrades to read-only while revocation checks are unavailable', async () => {
  const admin = await tenant()
  const unitId = await unit(admin.token)
  runtime.redis.disconnect()
  try {
    await request(app.getHttpServer()).get('/items').set(authorized(admin.token)).expect(200)
    await request(app.getHttpServer())
      .post('/items')
      .set(authorized(admin.token))
      .send({ kind: 'product', sku: `OUTAGE-${randomBytes(3).toString('hex')}`, name: 'X', unitId })
      .expect(503)
    await request(app.getHttpServer()).get('/health/ready').expect(503)
  } finally {
    await runtime.redis.connect()
  }
  await request(app.getHttpServer()).get('/health/ready').expect(200)
})

it('answers 503, not 401, when the key set itself cannot be reached', async () => {
  const admin = await tenant()
  const offline = await Test.createTestingModule({
    imports: [
      AppModule.register(
        readEnvironment({
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          // Nothing listens here: an unreachable key set is an outage, not a forgery.
          JWKS_URL: 'http://127.0.0.1:1/.well-known/jwks.json',
          IDEMPOTENCY_SECRET: randomBytes(32).toString('hex'),
          DATABASE_RELAY_URL: undefined,
        }),
      ),
    ],
  }).compile()
  const isolated = offline.createNestApplication({ logger: false })
  await isolated.init()
  try {
    await request(isolated.getHttpServer()).get('/items').set(authorized(admin.token)).expect(503)
  } finally {
    await isolated.close()
  }
})

it('publishes request schemas, permissions and the outage exception in OpenAPI', () => {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Horizon Catalog').setVersion('0.1.0').addBearerAuth().build(),
  )
  expect(document.paths['/items']?.post).toMatchObject({
    'x-catalog-permission': { action: 'manage', subject: 'Items' },
    security: [{ bearer: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', required: ['kind', 'sku', 'name', 'unitId'] },
        },
      },
    },
  })
  expect(document.paths['/items']?.get).toMatchObject({
    'x-catalog-permission': { action: 'read', subject: 'Items' },
    'x-revocation-store-outage': 'allow-read',
  })
  // A write is never in the outage exception, and health carries no permission at all.
  expect(document.paths['/items']?.post).not.toHaveProperty('x-revocation-store-outage')
  expect(document.paths['/health/live']?.get).not.toHaveProperty('x-catalog-permission')
  expect(Object.keys(document.paths).sort()).toEqual([
    '/health/live',
    '/health/ready',
    '/items',
    '/items/{itemId}/deactivate',
    '/price-lists',
    '/price-lists/{priceListId}/prices/{itemId}',
    '/units',
  ])
})
