import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { FiscalBackfill, HttpOwnerFiscalClient, type OwnerFiscalClient } from '../src/backfill'
import { FiscalConsumer } from '../src/consumer'
import { FiscalDocuments } from '../src/documents'
import { FiscalIngress } from '../src/ingress'
import { FiscalProjections } from '../src/projections'

let container: StartedPostgreSqlContainer
let rabbitmq: StartedRabbitMQContainer
let app: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>
let ingress: FiscalIngress
let projections: FiscalProjections
let documents: FiscalDocuments

beforeAll(async () => {
  ;[container, rabbitmq] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_fiscal_test')
      .withUsername('postgres')
      .withPassword('test')
      .start(),
    new RabbitMQContainer('rabbitmq:4-management-alpine').start(),
  ])
  administrator = postgres(container.getConnectionUri(), { max: 1 })
  await administrator.unsafe(
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`,
    [],
    { prepare: false },
  )
  const migrationUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_owner:test@')
  const appUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
  })
  app = postgres(appUrl, { max: 1 })
  ingress = new FiscalIngress(appUrl)
  projections = new FiscalProjections(appUrl)
  documents = new FiscalDocuments(appUrl)
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([
    ingress?.close(),
    projections?.close(),
    documents?.close(),
    app?.end(),
    administrator?.end(),
    container?.stop(),
    rabbitmq?.stop(),
  ])
})

it('consumes duplicate broker deliveries into one fiscal intent', async () => {
  const tenantId = randomUUID()
  const shipmentId = randomUUID()
  const partyId = randomUUID()
  const first = origin(tenantId, shipmentId)
  const ownerServer = createServer((request, response) => {
    if (
      request.headers.authorization !== 'Bearer tenant-fiscal-reader-token' ||
      request.url !== `/parties/${partyId}/fiscal-profile/1`
    ) {
      response.writeHead(403).end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        tenantId,
        partyId,
        kind: 'organization',
        legalName: 'Empresa Exemplo',
        tradeName: null,
        taxId: '00000000E08G12',
        revision: 1,
        profile: {
          effectiveFrom: '2026-09-01',
          stateRegistration: null,
          municipalRegistration: null,
          taxpayerIndicator: 'contributor',
          finalConsumer: false,
          address: {
            street: 'Rua Um',
            number: '1',
            complement: null,
            district: 'Centro',
            city: 'São Paulo',
            municipalityCode: '3550308',
            state: 'SP',
            postalCode: '01001000',
            country: 'BR',
          },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => ownerServer.listen(0, '127.0.0.1', resolve))
  const address = ownerServer.address()
  if (!address || typeof address === 'string') throw new Error('Owner test server has no port')
  const url = `http://127.0.0.1:${address.port}`
  const owner = new HttpOwnerFiscalClient(
    { parties: url, identity: url, catalog: url },
    'tenant-fiscal-reader-token',
  )
  const consumer = new FiscalConsumer(rabbitmq.getAmqpUrl(), ingress, projections, () => owner)
  const publisher = await connect(rabbitmq.getAmqpUrl())
  const channel = await publisher.createConfirmChannel()
  try {
    await consumer.start()
    const notice = {
      ...first,
      eventId: randomUUID(),
      eventType: 'parties.party.fiscal-profile-changed',
      payload: { partyId, revision: 1, effectiveFrom: '2026-09-01' },
    }
    for (const event of [first, { ...first, eventId: randomUUID() }, notice]) {
      channel.publish('horizon.events', event.eventType, Buffer.from(JSON.stringify(event)), {
        persistent: true,
        messageId: event.eventId,
      })
    }
    await channel.waitForConfirms()
    const deadline = Date.now() + 5000
    for (;;) {
      const [result] = await administrator`select count(*)::integer as value from inbox
        where tenant_id = ${tenantId} and event_type = 'sales.fiscal-origin.recorded'`
      if (result?.value === 2) break
      if (Date.now() > deadline) throw new Error('Fiscal broker consumption timed out')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const [count] = await administrator`select count(*)::integer as value from fiscal_intents
      where tenant_id = ${tenantId} and origin_id = ${shipmentId}`
    expect(count?.value).toBe(1)
    for (;;) {
      if (await projections.readParty(tenantId, partyId, 1)) break
      if (Date.now() > deadline) throw new Error('Fiscal profile projection timed out')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await projections.readParty(tenantId, partyId, 1)).toMatchObject({
      taxId: '00000000E08G12',
      revision: 1,
    })
    channel.publish('horizon.events.dlx', 'catalog.price.changed', Buffer.from('other-module'))
    await channel.waitForConfirms()
    expect((await channel.checkQueue('fiscal.events.dlq')).messageCount).toBe(0)
  } finally {
    await consumer.close()
    await channel.close()
    await publisher.close()
    await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
  }
})

it('encrypts exact owner revisions and destroys access on party erasure', async () => {
  const tenantId = randomUUID()
  const partyId = randomUUID()
  const notice = {
    eventId: randomUUID(),
    eventType: 'parties.party.fiscal-profile-changed',
    eventVersion: 1,
    occurredAt: '2026-09-21T12:00:00.000Z',
    tenantId,
    traceId: 'b'.repeat(32),
    payload: { partyId, revision: 1, effectiveFrom: '2026-09-01' },
  }
  await ingress.accept(notice)
  const exported = {
    tenantId,
    partyId,
    kind: 'organization',
    legalName: 'Torrefação Serra LTDA',
    tradeName: null,
    taxId: '00000000E08G12',
    revision: 1,
    profile: {
      effectiveFrom: '2026-09-01',
      stateRegistration: '123456',
      municipalRegistration: null,
      taxpayerIndicator: 'contributor',
      finalConsumer: false,
      address: {
        street: 'Rua Um',
        number: '42',
        complement: null,
        district: 'Centro',
        city: 'São Paulo',
        municipalityCode: '3550308',
        state: 'SP',
        postalCode: '01001000',
        country: 'BR',
      },
    },
  }
  expect(await projections.storeParty(tenantId, partyId, 1, exported)).toBe('inserted')
  expect(await projections.storeParty(tenantId, partyId, 1, exported)).toBe('existing')
  expect(await projections.readParty(tenantId, partyId, 1)).toEqual(exported)
  expect(await projections.readParty(randomUUID(), partyId, 1)).toBeNull()
  await expect(projections.storeParty(randomUUID(), partyId, 1, exported)).rejects.toThrow(
    'does not match',
  )
  const [stored] = await administrator`select ciphertext from profile_revisions
    where tenant_id = ${tenantId} and subject_id = ${partyId}`
  expect(JSON.stringify(stored)).not.toContain('E08G')
  expect(JSON.stringify(stored)).not.toContain('3550308')

  await ingress.accept({
    ...notice,
    eventId: randomUUID(),
    eventType: 'parties.party.erased',
    payload: { partyId },
  })
  expect(await projections.readParty(tenantId, partyId, 1)).toBeNull()
  await expect(projections.storeParty(tenantId, partyId, 1, exported)).rejects.toThrow('erased')
  const [key] = await administrator`select material, erased_at from profile_keys
    where tenant_id = ${tenantId} and subject_id = ${partyId}`
  expect(key?.material).toBeNull()
  expect(key?.erased_at).not.toBeNull()
  const latePartyId = randomUUID()
  await ingress.accept({
    ...notice,
    eventId: randomUUID(),
    eventType: 'parties.party.erased',
    payload: { partyId: latePartyId },
  })
  await expect(
    projections.storeParty(tenantId, latePartyId, 1, { ...exported, partyId: latePartyId }),
  ).rejects.toThrow('erased')
})

it('keeps issuer and catalog notices versioned and tenant scoped', async () => {
  const tenantId = randomUUID()
  const itemId = randomUUID()
  const base = {
    eventId: randomUUID(),
    eventVersion: 1,
    occurredAt: '2026-09-21T12:00:00.000Z',
    tenantId,
    traceId: 'c'.repeat(32),
  }
  const issuerNotice = {
    ...base,
    eventType: 'identity.company.fiscal-profile-changed',
    payload: { tenantId, revision: 1, effectiveFrom: '2026-09-01' },
  }
  expect(await ingress.accept(issuerNotice)).toBe('applied')
  expect(await ingress.accept({ ...issuerNotice, eventId: randomUUID() })).toBe('applied')
  await expect(
    ingress.accept({
      ...issuerNotice,
      eventId: randomUUID(),
      payload: { ...issuerNotice.payload, tenantId: randomUUID() },
    }),
  ).rejects.toThrow('tenant mismatch')
  const classification = {
    ...base,
    eventId: randomUUID(),
    eventType: 'catalog.item.classification-changed',
    payload: { itemId, revision: 1, effectiveFrom: '2026-09-01', ncm: '09012100' },
  }
  expect(await ingress.accept(classification)).toBe('applied')
  await expect(
    ingress.accept({
      ...classification,
      eventId: randomUUID(),
      payload: { ...classification.payload, ncm: '09012200' },
    }),
  ).rejects.toThrow('Conflicting catalog classification')
  const [profile] = await administrator`select count(*)::integer as value from profile_requests
    where tenant_id = ${tenantId} and source_module = 'identity'`
  const [catalog] =
    await administrator`select count(*)::integer as value from catalog_classifications
    where tenant_id = ${tenantId} and item_id = ${itemId}`
  expect(profile?.value).toBe(1)
  expect(catalog?.value).toBe(1)
})

function origin(tenantId: string, originId: string, purpose: 'original' | 'return' = 'original') {
  const orderId = randomUUID()
  const customerId = randomUUID()
  const itemId = randomUUID()
  return {
    eventId: randomUUID(),
    eventType: 'sales.fiscal-origin.recorded',
    eventVersion: 1,
    occurredAt: '2026-09-21T12:00:00.000Z',
    tenantId,
    traceId: 'a'.repeat(32),
    payload: {
      orderId,
      originModule: 'sales',
      originDocumentType: 'shipment',
      originId,
      purpose,
      customerId,
      lines: [
        {
          lineId: randomUUID(),
          itemId,
          quantity: '1',
          description: 'Item',
          unitPrice: { amount: '1000', currency: 'BRL' },
          lineTotal: { amount: '1000', currency: 'BRL' },
        },
      ],
      total: { amount: '1000', currency: 'BRL' },
    },
  }
}

it('creates one intent for two messages about one delivery and isolates tenants', async () => {
  const tenantId = randomUUID()
  const shipmentId = randomUUID()
  const first = origin(tenantId, shipmentId)
  expect(await ingress.accept(first)).toBe('applied')
  expect(await ingress.accept(first)).toBe('duplicate')
  expect(await ingress.accept({ ...first, eventId: randomUUID() })).toBe('applied')
  const second = origin(tenantId, randomUUID())
  const returned = origin(tenantId, shipmentId, 'return')
  await ingress.accept(second)
  await ingress.accept(returned)

  const rows = await administrator`select origin_id, purpose, status from fiscal_intents
    where tenant_id = ${tenantId}`
  expect(rows).toHaveLength(3)
  expect(rows.filter((row) => row.purpose === 'original')).toHaveLength(2)
  expect(rows.filter((row) => row.purpose === 'return')).toHaveLength(1)
  expect(rows.every((row) => row.status === 'blocked_profile')).toBe(true)

  const otherTenant = randomUUID()
  await ingress.accept({ ...first, tenantId: otherTenant, eventId: randomUUID() })
  const hidden = await app.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`
    return tx`select id from fiscal_intents where tenant_id = ${otherTenant}`
  })
  expect(hidden).toHaveLength(0)
  await expect(
    app.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into fiscal_intents
        (id, tenant_id, origin_module, origin_document_type, origin_id, purpose,
         order_id, customer_id, payload_digest)
        values (${randomUUID()}, ${otherTenant}, 'sales', 'shipment', ${randomUUID()},
          'original', ${randomUUID()}, ${randomUUID()}, 'x')`
    }),
  ).rejects.toThrow()
  await expect(
    ingress.accept({
      ...first,
      eventId: randomUUID(),
      payload: { ...first.payload, total: { amount: '2000', currency: 'BRL' } },
    }),
  ).rejects.toThrow('Conflicting fiscal origin payload')
  const [count] = await administrator`select count(*)::integer as value from fiscal_intents
    where tenant_id = ${tenantId} and origin_id = ${shipmentId} and purpose = 'original'`
  expect(count?.value).toBe(1)
})

it('keeps one immutable draft per origin and reserves unique numbers under concurrent retries', async () => {
  const tenantId = randomUUID()
  const otherTenant = randomUUID()
  await ingress.accept(origin(tenantId, randomUUID()))
  await ingress.accept(origin(tenantId, randomUUID()))
  await ingress.accept(origin(otherTenant, randomUUID()))
  const intents = await administrator`select id, tenant_id from fiscal_intents
    where tenant_id in (${tenantId}, ${otherTenant}) order by created_at, id`
  const own = intents.filter((row) => row.tenant_id === tenantId)
  const foreign = intents.find((row) => row.tenant_id === otherTenant)
  if (!own[0] || !own[1] || !foreign) throw new Error('Test intents were not stored')
  const establishmentId = randomUUID()
  const input = {
    tenantId,
    intentId: String(own[0].id),
    model: '55' as const,
    environment: 'simulation' as const,
    establishmentId,
    series: 1,
    snapshot: { origin: String(own[0].id), amount: '1000' },
  }
  const [first, duplicate] = await Promise.all([
    documents.createDraft(input),
    documents.createDraft(input),
  ])
  expect(duplicate.id).toBe(first.id)
  await expect(documents.createDraft({ ...input, snapshot: { amount: '2000' } })).rejects.toThrow(
    'Conflicting fiscal draft',
  )
  await expect(documents.createDraft({ ...input, intentId: String(foreign.id) })).rejects.toThrow()
  const second = await documents.createDraft({
    ...input,
    intentId: String(own[1].id),
    snapshot: { origin: String(own[1].id) },
  })
  const [numberA, retryA, numberB] = await Promise.all([
    documents.reserveNumber(tenantId, first.id),
    documents.reserveNumber(tenantId, first.id),
    documents.reserveNumber(tenantId, second.id),
  ])
  expect(numberA).toBe(retryA)
  expect(new Set([numberA, numberB]).size).toBe(2)
  expect([numberA, numberB].sort()).toEqual([1, 2])
  await expect(documents.reserveNumber(otherTenant, first.id)).rejects.toThrow('not found')
  const [count] = await administrator`select count(*)::integer as value
    from fiscal_number_reservations where tenant_id = ${tenantId}`
  expect(count?.value).toBe(2)
  const [transitions] = await administrator`select count(*)::integer as value
    from fiscal_transitions where tenant_id = ${tenantId}`
  expect(transitions?.value).toBe(4)
})

it('resumes owner API backfill and verifies issuer, party and catalog revisions', async () => {
  const tenantId = randomUUID()
  const [firstId, secondId] = [randomUUID(), randomUUID()].sort()
  if (!firstId || !secondId) throw new Error('Expected two parties')
  const itemId = randomUUID()
  let failSecondPage = true
  const owner: OwnerFiscalClient = {
    async listParties(_limit, cursor) {
      if (cursor && failSecondPage) {
        failSecondPage = false
        throw new Error('Temporary owner outage')
      }
      return cursor
        ? { tenantId, data: [{ partyId: secondId, revision: 1 }], nextCursor: null }
        : { tenantId, data: [{ partyId: firstId, revision: 2 }], nextCursor: firstId }
    },
    async partyRevision(partyId, revision) {
      return {
        tenantId,
        partyId,
        kind: 'organization',
        legalName: 'Empresa Exemplo',
        tradeName: null,
        taxId: '00000000E08G12',
        revision,
        profile: {
          effectiveFrom: revision === 1 ? '2026-09-01' : '2026-09-02',
          stateRegistration: null,
          municipalRegistration: null,
          taxpayerIndicator: 'contributor',
          finalConsumer: false,
          address: {
            street: 'Rua Um',
            number: '1',
            complement: null,
            district: 'Centro',
            city: 'São Paulo',
            municipalityCode: '3550308',
            state: 'SP',
            postalCode: '01001000',
            country: 'BR',
          },
        },
      }
    },
    async issuerRevisions() {
      return { tenantId, data: [{ revision: 1 }] }
    },
    async issuerRevision(revision) {
      return {
        tenantId,
        revision,
        effectiveFrom: '2026-09-01',
        timezone: 'America/Sao_Paulo',
        company: {
          legalName: 'Emissora Exemplo',
          tradeName: null,
          taxId: '00000000E08G12',
          stateRegistration: null,
          municipalRegistration: null,
          address: {
            line: 'Rua Um, 1',
            city: 'São Paulo',
            municipalityCode: '3550308',
            state: 'SP',
            postalCode: '01001000',
            country: 'BR',
          },
          baseCurrency: 'BRL',
          fiscalRegime: 'simples-nacional',
        },
      }
    },
    async listClassifications() {
      return { tenantId, data: [{ itemId, revision: 1 }], nextCursor: null }
    },
    async classificationRevision(requestedId, revision) {
      return {
        tenantId,
        itemId: requestedId,
        revision,
        effectiveFrom: '2026-09-01',
        ncm: '09012100',
      }
    },
  }
  const appUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  const backfill = new FiscalBackfill(appUrl, projections, owner)
  try {
    await expect(backfill.parties(randomUUID(), 1)).rejects.toThrow('tenant mismatch')
    await expect(backfill.parties(tenantId, 1)).rejects.toThrow('Temporary owner outage')
    const [partial] = await administrator`select cursor, observed_count from backfill_checkpoints
      where tenant_id = ${tenantId} and source_module = 'parties'`
    expect(partial).toMatchObject({ cursor: firstId, observed_count: 2 })
    const partiesResult = await backfill.parties(tenantId, 1)
    expect(partiesResult).toMatchObject({
      source: 'parties',
      observedCount: 3,
    })
    const issuerResult = await backfill.issuer(tenantId)
    expect(issuerResult).toMatchObject({ source: 'identity', observedCount: 1 })
    const catalogResult = await backfill.catalog(tenantId, 1)
    expect(catalogResult).toMatchObject({
      source: 'catalog',
      observedCount: 1,
    })
    expect(await backfill.reconcile(tenantId, partiesResult)).toMatchObject({
      checkpointCount: 3,
      projectedCount: 3,
    })
    expect(await backfill.reconcile(tenantId, issuerResult)).toMatchObject({
      checkpointCount: 1,
      projectedCount: 1,
    })
    expect(await backfill.reconcile(tenantId, catalogResult)).toMatchObject({
      checkpointCount: 1,
      projectedCount: 1,
    })
    await expect(
      backfill.reconcile(tenantId, { ...partiesResult, digest: 'wrong' }),
    ).rejects.toThrow('checkpoint does not match')
    expect(await projections.readParty(tenantId, firstId, 2)).toMatchObject({ revision: 2 })
    expect(await projections.readIssuer(tenantId, 1)).toMatchObject({ tenantId, revision: 1 })
    const [classification] = await administrator`select ncm from catalog_classifications
      where tenant_id = ${tenantId} and item_id = ${itemId}`
    expect(classification?.ncm).toBe('09012100')
  } finally {
    await backfill.close()
  }
})
