import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { fiscalArtifactListV2Schema, fiscalDocumentHomologationObserved } from '@horizon/contracts'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq'
import { connect } from 'amqplib'
import { PDFDocument } from 'pdf-lib'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { FiscalArtifacts } from '../src/artifacts'
import { type AuditRow, verifyAuditRows } from '../src/audit'
import { FiscalBackfill, HttpOwnerFiscalClient, type OwnerFiscalClient } from '../src/backfill'
import { canonicalDigest } from '../src/canonical-json'
import { FiscalCapabilities } from '../src/capabilities'
import { FiscalConsumer } from '../src/consumer'
import { FiscalDocuments } from '../src/documents'
import { FiscalEstablishmentCredentials } from '../src/establishment-credentials'
import { HomologationCancellation } from '../src/homologation-cancellation'
import { HomologationDanfe } from '../src/homologation-danfe'
import { HomologationExchangeLedger } from '../src/homologation-exchange-ledger'
import {
  HomologationExchangeRunner,
  UncertainSefazOutcomeError,
} from '../src/homologation-exchange-runner'
import { HomologationExchangeWorker } from '../src/homologation-exchange-worker'
import { HomologationIssuance } from '../src/homologation-issuance'
import { HomologationObservations } from '../src/homologation-observations'
import { HomologationRawRecovery } from '../src/homologation-raw-recovery'
import { HomologationRecovery } from '../src/homologation-recovery'
import { HomologationRestoreVerifier } from '../src/homologation-restore-verifier'
import { FiscalIngress } from '../src/ingress'
import { FiscalLifecycle } from '../src/lifecycle'
import { buildNfe55AccessKey } from '../src/nfe55/access-key'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from '../src/nfe55/sefaz-adapter'
import { SefazResponseSchemaValidator } from '../src/nfe55/sefaz-response-schema'
import { parseFiscalOriginSnapshot } from '../src/origin-snapshot'
import { FiscalOutboxRelay } from '../src/outbox'
import { DeterministicAuthorityGateway } from '../src/ports'
import { FiscalProjections } from '../src/projections'
import { FiscalSupport } from '../src/support'

let container: StartedPostgreSqlContainer
let rabbitmq: StartedRabbitMQContainer
let app: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>
let ingress: FiscalIngress
let projections: FiscalProjections
let documents: FiscalDocuments
let artifactRoot: string
let artifactKey: Buffer
let appUrl: string

it('keeps A1 credentials encrypted and isolated by tenant and establishment', async () => {
  const tenantA = randomUUID()
  const tenantB = randomUUID()
  const establishment = randomUUID()
  await administrator`insert into tenants (id) values (${tenantA}), (${tenantB})`
  const registry = new FiscalEstablishmentCredentials(appUrl, artifactKey)
  const paths: string[] = []
  try {
    for (const [index, taxId] of ['12345678000195', '98765432000100'].entries()) {
      const certificatePath = join(artifactRoot, `a1-${index}.pem`)
      const privateKeyPath = join(artifactRoot, `a1-${index}.key`)
      const pfxPath = join(artifactRoot, `a1-${index}.pfx`)
      paths.push(certificatePath, privateKeyPath, pfxPath)
      await promisify(execFile)('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=Horizon A1 Test Only',
        '-addext',
        `subjectAltName=otherName:2.16.76.1.3.3;PRINTABLE:${taxId}`,
        '-keyout',
        privateKeyPath,
        '-out',
        certificatePath,
      ])
      await promisify(execFile)('openssl', [
        'pkcs12',
        '-export',
        '-inkey',
        privateKeyPath,
        '-in',
        certificatePath,
        '-out',
        pfxPath,
        '-passout',
        'pass:test-only-password',
      ])
      const saved = await registry.upload({
        tenantId: tenantA,
        establishmentId: establishment,
        pfx: await readFile(pfxPath),
        password: 'test-only-password',
        actorId: 'test:fiscal-admin',
      })
      expect(saved.issuerTaxId).toBe(taxId)
      if (index === 0) {
        await expect(
          registry.upload({
            tenantId: tenantB,
            establishmentId: establishment,
            pfx: await readFile(pfxPath),
            password: 'wrong',
            actorId: 'test:fiscal-admin',
          }),
        ).rejects.toThrow('Invalid certificate file or password')
        expect(await registry.list(tenantB)).toHaveLength(0)
      }
    }
    const [active] = await registry.list(tenantA)
    expect(active?.issuer_tax_id).toBe('98765432000100')
    expect((await registry.active(tenantA, establishment)).issuerTaxId).toBe('98765432000100')
    await expect(registry.active(tenantA, randomUUID())).rejects.toThrow(
      'No certificate configured',
    )
    const rows =
      await administrator`select encrypted_pem, fingerprint from fiscal_establishment_credentials
      where tenant_id = ${tenantA} order by uploaded_at`
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect((row.encrypted_pem as Buffer).toString()).not.toContain('PRIVATE KEY')
      expect((row.encrypted_pem as Buffer).toString()).not.toContain('CERTIFICATE')
    }
    expect(await registry.list(tenantB)).toHaveLength(0)
    await expect(registry.active(tenantB, establishment)).rejects.toThrow(
      'No certificate configured',
    )
    const wrongKey = new FiscalEstablishmentCredentials(appUrl, randomBytes(32))
    try {
      await expect(wrongKey.active(tenantA, establishment)).rejects.toThrow()
    } finally {
      await wrongKey.close()
    }
  } finally {
    await registry.close()
    await Promise.all(paths.map((path) => rm(path, { force: true })))
  }
}, 60_000)

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
  appUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  artifactRoot = await mkdtemp(join(tmpdir(), 'horizon-fiscal-artifacts-'))
  artifactKey = randomBytes(32)
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
  })
  app = postgres(appUrl, { max: 1 })
  ingress = new FiscalIngress(appUrl, artifactKey)
  projections = new FiscalProjections(appUrl)
  documents = new FiscalDocuments(appUrl, artifactKey)
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
    artifactRoot && rm(artifactRoot, { recursive: true, force: true }),
  ])
})

it('publishes tenant-scoped simulation outbox events with confirms and marks delivery once', async () => {
  const tenantId = randomUUID()
  const otherTenantId = randomUUID()
  const eventId = randomUUID()
  const otherEventId = randomUUID()
  const homologationEventId = randomUUID()
  const documentId = randomUUID()
  const payload = {
    documentId,
    rootDocumentId: documentId,
    revision: 1,
    originModule: 'sales',
    originDocumentType: 'shipment',
    originId: randomUUID(),
    originPurpose: 'original',
    model: '55',
    environment: 'simulation',
    simulated: true,
    adapterVersion: 'nfe55-simulator-v1',
    statusDigest: 'a'.repeat(64),
    observedAt: '2026-09-22T17:00:00.000Z',
    authorityReference: 'simulation:authorized',
    protocolDigest: 'b'.repeat(64),
  }
  await administrator`insert into tenants (id) values (${tenantId}), (${otherTenantId})`
  await administrator`insert into fiscal_outbox (tenant_id, event_id, event_type, payload)
    values (${tenantId}, ${eventId}, 'fiscal.document.simulation-authorized',
      ${administrator.json(payload)}),
      (${otherTenantId}, ${otherEventId}, 'fiscal.document.simulation-authorized',
      ${administrator.json({ ...payload, documentId: randomUUID() })})`
  const homologationPayload = fiscalDocumentHomologationObserved.payload.parse({
    documentId,
    exchangeId: randomUUID(),
    service: 'status',
    model: '55',
    environment: 'homologation',
    fiscalValue: false,
    adapterVersion: 'nfe55-sp-homologation-v1',
    decision: 'available',
    statusCode: '107',
    documentStatusCode: null,
    eventStatusCode: null,
    requestDigest: 'c'.repeat(64),
    responseDigest: 'd'.repeat(64),
    protocolDigest: null,
    observedAt: '2026-09-22T17:00:00.000Z',
  })
  await administrator`insert into fiscal_outbox (tenant_id, event_id, event_type, payload)
    values (${tenantId}, ${homologationEventId}, ${fiscalDocumentHomologationObserved.type},
      ${administrator.json(homologationPayload)})`
  const connection = await connect(rabbitmq.getAmqpUrl())
  const channel = await connection.createChannel()
  const relay = new FiscalOutboxRelay(appUrl, rabbitmq.getAmqpUrl())
  const support = new FiscalSupport(appUrl)
  try {
    await channel.assertExchange('horizon.events', 'topic', { durable: true })
    await channel.assertQueue('phase42.fiscal-outbox.test', { durable: true })
    await channel.assertQueue('phase43.homologation-outbox.test', { durable: true })
    await channel.bindQueue(
      'phase42.fiscal-outbox.test',
      'horizon.events',
      'fiscal.document.simulation-authorized',
    )
    await channel.bindQueue(
      'phase43.homologation-outbox.test',
      'horizon.events',
      fiscalDocumentHomologationObserved.type,
    )
    expect(await relay.flush(tenantId)).toBe(2)
    expect(await relay.flush(tenantId)).toBe(0)
    const received = await channel.get('phase42.fiscal-outbox.test', { noAck: true })
    expect(received).not.toBe(false)
    if (!received) throw new Error('Fiscal outbox event was not published')
    expect(JSON.parse(received.content.toString())).toMatchObject({
      eventId,
      tenantId,
      eventType: 'fiscal.document.simulation-authorized',
      eventVersion: 1,
      payload: { documentId, simulated: true },
    })
    expect(await channel.get('phase42.fiscal-outbox.test', { noAck: true })).toBe(false)
    const homologationReceived = await channel.get('phase43.homologation-outbox.test', {
      noAck: true,
    })
    expect(homologationReceived).not.toBe(false)
    if (!homologationReceived) throw new Error('Homologation outbox event was not published')
    expect(JSON.parse(homologationReceived.content.toString())).toMatchObject({
      eventId: homologationEventId,
      tenantId,
      eventType: fiscalDocumentHomologationObserved.type,
      eventVersion: 1,
      payload: { environment: 'homologation', fiscalValue: false, decision: 'available' },
    })
    expect(await channel.get('phase43.homologation-outbox.test', { noAck: true })).toBe(false)
    const rows = await administrator`select tenant_id, delivered_at from fiscal_outbox
      where event_id in (${eventId}, ${otherEventId}) order by tenant_id`
    expect(rows.find((row) => row.tenant_id === tenantId)?.delivered_at).not.toBeNull()
    expect(rows.find((row) => row.tenant_id === otherTenantId)?.delivered_at).toBeNull()
    await expect(
      administrator`update fiscal_outbox set payload = ${administrator.json({ altered: true })}
        where tenant_id = ${tenantId} and event_id = ${eventId}`,
    ).rejects.toMatchObject({ code: '23514' })

    // Phase 48: an audited replay republishes a delivered event under its own id, once.
    const replay = {
      reason: 'Projeção do consumidor reconstruída após incidente',
      limit: 10,
      eventIds: [eventId, otherEventId],
    }
    const requested = await support.replayOutbox(tenantId, 'support:operator', replay)
    expect(requested.changed.map((row) => row.id)).toEqual([eventId])
    // The other tenant's event is invisible, and a second request waits on the first.
    expect((await support.replayOutbox(tenantId, 'support:operator', replay)).skipped).toEqual([
      { id: eventId, reason: 'a replay is already pending' },
    ])
    await expect(
      support.replayOutbox(tenantId, 'support:operator', { ...replay, eventIds: [] }),
    ).rejects.toThrow(/document or explicit event ids/)
    expect(await relay.flush(tenantId)).toBe(1)
    expect(await relay.flush(tenantId)).toBe(0)
    const replayed = await channel.get('phase42.fiscal-outbox.test', { noAck: true })
    if (!replayed) throw new Error('Replayed Fiscal event was not published')
    expect(JSON.parse(replayed.content.toString())).toMatchObject({ eventId, tenantId })
    expect(replayed.properties.messageId).toBe(eventId)
    expect(await channel.get('phase42.fiscal-outbox.test', { noAck: true })).toBe(false)
    await expect(
      administrator`update fiscal_outbox_replays set reason = 'altered replay reason'
        where tenant_id = ${tenantId}`,
    ).rejects.toMatchObject({ code: '23514' })
    const audit = await administrator`select action from fiscal_audit_entries
      where tenant_id = ${tenantId} and action = 'support.replay-outbox'`
    expect(audit).toHaveLength(1)
  } finally {
    await support.close()
    await relay.close()
    await channel.deleteQueue('phase42.fiscal-outbox.test')
    await channel.deleteQueue('phase43.homologation-outbox.test')
    await channel.close()
    await connection.close()
  }
})

it('forces tenant RLS on every Fiscal business table', async () => {
  const rows = await administrator`
    select relname, relrowsecurity, relforcerowsecurity
    from pg_class where relkind = 'r'
      and relnamespace = 'public'::regnamespace
      and relname <> 'fiscal_migrations' order by relname`
  expect(rows.map((row) => row.relname)).toEqual(
    expect.arrayContaining([
      'fiscal_package_reviews',
      'fiscal_reference_entries',
      'fiscal_tax_rules',
      'fiscal_rule_activation_events',
      'fiscal_source_payloads',
      'fiscal_outbox_replays',
    ]),
  )
  expect(
    rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity).map((row) => row.relname),
  ).toEqual([])
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
    // Another module's dead letters never reach Fiscal's (Phase 90): each queue dead-letters
    // into an exchange of its own.
    await channel.assertExchange('catalog.events.dlx', 'fanout', { durable: true })
    channel.publish('catalog.events.dlx', '', Buffer.from('other-module'))
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
  // Published before Phase 89, the revision says nothing about IPI, and reads as false.
  expect(
    (await projections.resolveClassification(tenantId, itemId, '2026-09-15'))?.ipiTaxpayer,
  ).toBe(false)
  const manufactured = {
    ...classification,
    eventId: randomUUID(),
    payload: {
      ...classification.payload,
      revision: 2,
      effectiveFrom: '2026-10-01',
      ipiTaxpayer: true,
    },
  }
  expect(await ingress.accept(manufactured)).toBe('applied')
  await expect(
    ingress.accept({
      ...manufactured,
      eventId: randomUUID(),
      payload: { ...manufactured.payload, ipiTaxpayer: false },
    }),
  ).rejects.toThrow('Conflicting catalog classification')
  expect(await projections.resolveClassification(tenantId, itemId, '2026-10-02')).toMatchObject({
    revision: 2,
    ipiTaxpayer: true,
  })
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

it('ingests one canonical pre-dispatch origin and rejects conflicting versions', async () => {
  const tenantId = randomUUID()
  const shipmentId = randomUUID()
  const legacy = origin(tenantId, shipmentId)
  const frozen = {
    ...legacy,
    eventVersion: 2,
    payload: {
      ...legacy.payload,
      orderVersion: 3,
      originRevision: 1,
      warehouseId: randomUUID(),
      establishmentId: randomUUID(),
      preDispatch: true,
    },
  }
  expect(await ingress.accept(frozen)).toBe('applied')
  expect(await ingress.accept(frozen)).toBe('duplicate')
  expect(await ingress.accept({ ...frozen, eventId: randomUUID() })).toBe('applied')
  const [stored] = await administrator`select id, payload_digest from fiscal_intents
    where tenant_id = ${tenantId} and origin_id = ${shipmentId}`
  expect(stored?.payload_digest).toBe(canonicalDigest(frozen.payload))
  const draftInput = {
    tenantId,
    intentId: String(stored?.id),
    model: '55' as const,
    environment: 'homologation' as const,
    establishmentId: frozen.payload.establishmentId,
    series: 1,
  }
  const [draft, retried] = await Promise.all([
    documents.createHomologationDraft(draftInput),
    documents.createHomologationDraft(draftInput),
  ])
  expect(retried.id).toBe(draft.id)
  expect(await documents.readSnapshot(tenantId, draft.id)).toEqual(frozen.payload)
  expect(await documents.get(tenantId, draft.id)).toMatchObject({
    environment: 'homologation',
    simulated: false,
    status: 'draft',
    establishmentId: frozen.payload.establishmentId,
  })
  await expect(
    documents.createHomologationDraft({
      ...draftInput,
      establishmentId: randomUUID(),
    }),
  ).rejects.toThrow('establishment mismatch')
  await expect(
    documents.createDraft({
      ...draftInput,
      environment: 'simulation',
    }),
  ).rejects.toThrow()
  await verifyHomologationLedger(tenantId, draft.id)
  await expect(ingress.accept({ ...legacy, eventId: randomUUID() })).rejects.toThrow(
    'Conflicting fiscal origin payload',
  )
})

async function verifyHomologationLedger(tenantId: string, documentId: string): Promise<void> {
  const artifacts = new FiscalArtifacts(
    appUrl,
    new EncryptedFiscalArtifactStore(new LocalObjectStore(artifactRoot), artifactKey),
  )
  const ledger = new HomologationExchangeLedger(appUrl, artifacts)
  const observations = new HomologationObservations(appUrl)
  const capabilities = new FiscalCapabilities(appUrl)
  try {
    const responseSchemas = new SefazResponseSchemaValidator(
      {
        archive: await readFile(new URL('../fixtures/official/pl-009p-v1.03.zip', import.meta.url)),
        digest: '2e925939a228aaf785be9fe7d6315f2da94d3a10036d54ffb7c1273aa7502b05',
      },
      {
        archive: await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
        digest: '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b',
      },
    )
    const operationNamespace = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4'
    const operations: SefazOperationMap = {
      wsdlDigest: 'a'.repeat(64),
      authorization: {
        operation: 'nfeAutorizacaoLote',
        operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
      },
      receipt: {
        operation: 'nfeRetAutorizacaoLote',
        operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4',
      },
      protocol: {
        operation: 'nfeConsultaNF',
        operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4',
      },
      status: { operation: 'nfeStatusServicoNF', operationNamespace },
      event: {
        operation: 'nfeRecepcaoEvento',
        operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4',
      },
    }
    const adapter = new SefazNfe55HomologationAdapter(
      { certificate: Buffer.alloc(0), issuerTaxId: '00000000E08G12' },
      operations,
      'SP',
    )
    const prepared = await adapter.prepare({ service: 'status' })
    const [document] = await administrator`select establishment_id from fiscal_documents
      where tenant_id = ${tenantId} and id = ${documentId}`
    const capability = await capabilities.register({
      tenantId,
      model: '55',
      environment: 'homologation',
      establishmentId: String(document?.establishment_id),
      jurisdictionKind: 'uf',
      jurisdictionCode: 'SP',
      operation: 'normal-sale',
      adapterVersion: 'nfe55-sp-homologation-v1',
      sourceManifestDigest: 'd'.repeat(64),
      schemaPackageDigest: 'e'.repeat(64),
      calculationFixtureId: 'reviewed-sp-v1',
      createdBy: 'author:phase43',
    })
    await capabilities.review({
      tenantId,
      capabilityId: capability.id,
      approved: true,
      reviewedBy: 'reviewer:phase43',
      interpretation: 'Scoped offline exchange drill.',
      reviewedAt: new Date().toISOString(),
    })
    const frozenOrigin = parseFiscalOriginSnapshot(
      await documents.readSnapshot(tenantId, documentId),
    )
    const firstItemId = frozenOrigin.lines[0]?.itemId
    if (!firstItemId) throw new Error('Offline homologation fixture has no item')
    const issuanceProfile = {
      capabilityId: capability.id,
      issuerAddress: {
        street: 'Rua Fiscal',
        number: '42',
        complement: null,
        district: 'Centro',
      },
      lineFacts: {
        [firstItemId]: {
          productCode: 'CAFE-001',
          cfop: '5102',
          unit: 'UN',
          ibsCbsCst: '000',
          ibsCbsClassification: '000001',
        },
      },
    }
    const profileReview = {
      tenantId,
      capabilityId: capability.id,
      sourceManifestDigest: 'd'.repeat(64),
      profile: issuanceProfile,
      reviewedBy: 'reviewer:phase43',
    }
    await expect(
      capabilities.registerHomologationIssuanceProfile({
        ...profileReview,
        reviewedBy: 'author:phase43',
      }),
    ).rejects.toThrow('differs from reviewed capability')
    expect(await capabilities.registerHomologationIssuanceProfile(profileReview)).toMatchObject({
      existing: false,
      profileDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(await capabilities.registerHomologationIssuanceProfile(profileReview)).toMatchObject({
      existing: true,
    })
    expect(await capabilities.getHomologationIssuanceProfile(tenantId, capability.id)).toEqual(
      issuanceProfile,
    )
    expect(
      await capabilities.getHomologationIssuanceProfile(randomUUID(), capability.id),
    ).toBeNull()
    const eventSchemaApproval = {
      tenantId,
      capabilityId: capability.id,
      sourceManifestDigest: 'd'.repeat(64),
      schemaDigest: '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b',
      reviewedBy: 'reviewer:phase43',
    }
    await expect(capabilities.approveHomologationEventSchema(eventSchemaApproval)).rejects.toThrow(
      'retained bytes do not match digest',
    )
    const eventSchemaBytes = await readFile(
      new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url),
    )
    const eventSchemaPackageId = randomUUID()
    await administrator`insert into fiscal_source_packages (
      id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
    ) values (
      ${eventSchemaPackageId}, ${tenantId}, 'offline-event-schema-fixture',
      'https://example.invalid/phase43-event-schema',
      ${eventSchemaApproval.schemaDigest}, '2026-09-23', '2026-09-23'
    )`
    await administrator`insert into fiscal_source_payloads (
      tenant_id, package_id, source_bytes, byte_size, imported_by
    ) values (
      ${tenantId}, ${eventSchemaPackageId}, ${eventSchemaBytes},
      ${eventSchemaBytes.length}, 'author:phase43'
    )`
    await administrator`insert into fiscal_package_reviews (
      id, tenant_id, package_id, approved, reviewed_by, reviewed_at,
      interpretation, fixture_ids
    ) values (
      ${randomUUID()}, ${tenantId}, ${eventSchemaPackageId}, true,
      'reviewer:phase43', now(), 'Offline event package review fixture',
      ${['reviewed-sp-v1']}
    )`
    await expect(
      capabilities.approveHomologationEventSchema({
        ...eventSchemaApproval,
        reviewedBy: 'author:phase43',
      }),
    ).rejects.toThrow('differs from reviewed capability')
    expect(await capabilities.approveHomologationEventSchema(eventSchemaApproval)).toEqual({
      existing: false,
    })
    expect(await capabilities.approveHomologationEventSchema(eventSchemaApproval)).toEqual({
      existing: true,
    })
    await expect(
      capabilities.approveHomologationEventSchema({
        ...eventSchemaApproval,
        schemaDigest: '5'.repeat(64),
      }),
    ).rejects.toThrow('Conflicting immutable homologation event schema approval')
    expect(await capabilities.getHomologationEventSchemaDigest(tenantId, capability.id)).toBe(
      eventSchemaApproval.schemaDigest,
    )
    expect(
      await capabilities.getHomologationEventSchemaDigest(randomUUID(), capability.id),
    ).toBeNull()
    const responseSchemaApproval = {
      tenantId,
      capabilityId: capability.id,
      sourceManifestDigest: 'd'.repeat(64),
      documentSchemaDigest: responseSchemas.documentDigest,
      consultationSchemaDigest: responseSchemas.consultationDigest,
      reviewedBy: 'reviewer:phase43',
    }
    await expect(
      capabilities.approveHomologationResponseSchemas(responseSchemaApproval),
    ).rejects.toThrow('retained bytes do not match digest')
    const documentResponseBytes = await readFile(
      new URL('../fixtures/official/pl-009p-v1.03.zip', import.meta.url),
    )
    const documentResponsePackageId = randomUUID()
    await administrator`insert into fiscal_source_packages (
      id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
    ) values (
      ${documentResponsePackageId}, ${tenantId}, 'offline-response-schema-fixture',
      'https://example.invalid/phase43-response-schema',
      ${responseSchemaApproval.documentSchemaDigest}, '2026-09-23', '2026-09-23'
    )`
    await administrator`insert into fiscal_source_payloads (
      tenant_id, package_id, source_bytes, byte_size, imported_by
    ) values (
      ${tenantId}, ${documentResponsePackageId}, ${documentResponseBytes},
      ${documentResponseBytes.length}, 'author:phase43'
    )`
    await administrator`insert into fiscal_package_reviews (
      id, tenant_id, package_id, approved, reviewed_by, reviewed_at,
      interpretation, fixture_ids
    ) values (
      ${randomUUID()}, ${tenantId}, ${documentResponsePackageId}, true,
      'reviewer:phase43', now(), 'Offline response package review fixture',
      ${['reviewed-sp-v1']}
    )`
    await expect(
      capabilities.approveHomologationResponseSchemas({
        ...responseSchemaApproval,
        reviewedBy: 'author:phase43',
      }),
    ).rejects.toThrow('differ from reviewed capability')
    await expect(
      capabilities.approveHomologationResponseSchemas({
        ...responseSchemaApproval,
        sourceManifestDigest: '5'.repeat(64),
      }),
    ).rejects.toThrow('differ from reviewed capability')
    expect(await capabilities.approveHomologationResponseSchemas(responseSchemaApproval)).toEqual({
      existing: false,
    })
    expect(await capabilities.approveHomologationResponseSchemas(responseSchemaApproval)).toEqual({
      existing: true,
    })
    await expect(
      capabilities.approveHomologationResponseSchemas({
        ...responseSchemaApproval,
        documentSchemaDigest: '5'.repeat(64),
      }),
    ).rejects.toThrow('retained bytes do not match digest')
    const packageId = randomUUID()
    const packageBytes = Buffer.from('{"fixture":"reviewed-sp-v1"}')
    const packageDigest = createHash('sha256').update(packageBytes).digest('hex')
    await administrator`insert into fiscal_source_packages (
      id, tenant_id, authority, source_uri, package_digest, published_at, effective_from
    ) values (
      ${packageId}, ${tenantId}, 'offline-review-fixture',
      'https://example.invalid/phase43-rules', ${packageDigest},
      '2026-09-23', '2026-09-23'
    )`
    await administrator`insert into fiscal_source_payloads (
      tenant_id, package_id, source_bytes, byte_size, imported_by
    ) values (${tenantId}, ${packageId}, ${packageBytes}, ${packageBytes.length}, 'author:phase43')`
    await administrator`insert into fiscal_package_reviews (
      id, tenant_id, package_id, approved, reviewed_by, reviewed_at,
      interpretation, fixture_ids
    ) values (
      ${randomUUID()}, ${tenantId}, ${packageId}, true, 'reviewer:phase43',
      now(), 'Offline calculation package review fixture', ${['reviewed-sp-v1']}
    )`
    const calculationApproval = {
      tenantId,
      capabilityId: capability.id,
      sourceManifestDigest: 'd'.repeat(64),
      calculationFixtureId: 'reviewed-sp-v1',
      packageDigests: [packageDigest],
      reviewedBy: 'reviewer:phase43',
    }
    await expect(
      capabilities.approveHomologationCalculation({
        ...calculationApproval,
        packageDigests: ['f'.repeat(64)],
      }),
    ).rejects.toThrow('lacks matching independent review')
    expect(await capabilities.approveHomologationCalculation(calculationApproval)).toEqual({
      existing: false,
    })
    expect(await capabilities.approveHomologationCalculation(calculationApproval)).toEqual({
      existing: true,
    })
    await expect(
      capabilities.approveHomologationCalculation({
        ...calculationApproval,
        packageDigests: ['f'.repeat(64)],
      }),
    ).rejects.toThrow('lacks matching independent review')
    const [draftForGuard] = await administrator`select snapshot_digest
      from fiscal_documents where tenant_id = ${tenantId} and id = ${documentId}`
    await expect(
      administrator.begin(async (tx) => {
        const calculationId = randomUUID()
        await tx`insert into fiscal_calculations (
          id, tenant_id, document_id, input_ciphertext, input_digest,
          resolved_rules, rules_digest, result_bytes, result_digest,
          explanation_template_version, explanation_text, rule_version_ids,
          package_digests, supported, actor_id
        ) values (
          ${calculationId}, ${tenantId}, ${documentId}, ${Buffer.from([1])},
          ${'a'.repeat(64)}, ${tx.json({ fixture: true })}, ${'b'.repeat(64)},
          ${Buffer.from('{}')}, ${'c'.repeat(64)}, 'fixture-v1', 'Offline guard fixture',
          ARRAY[]::uuid[], ${['f'.repeat(64)]}::text[], true, 'tester:phase43'
        )`
        await tx`insert into fiscal_document_calculation_bindings (
          tenant_id, document_id, calculation_id
        ) values (${tenantId}, ${documentId}, ${calculationId})`
        await tx`insert into fiscal_document_readiness_bindings (
          tenant_id, document_id, capability_id, issuer_profile_revision,
          recipient_party_id, recipient_profile_revision, classification_revisions,
          origin_digest, reconciliation_digest
        ) values (
          ${tenantId}, ${documentId}, ${capability.id}, 1, ${randomUUID()}, 1,
          ${tx.json({})}, ${draftForGuard?.snapshot_digest}, ${'d'.repeat(64)}
        )`
        await tx`update fiscal_documents set status = 'ready'
          where tenant_id = ${tenantId} and id = ${documentId}`
      }),
    ).rejects.toThrow('exact reviewed calculation packages')
    await administrator.begin(async (tx) => {
      const calculationId = randomUUID()
      await tx`insert into fiscal_calculations (
        id, tenant_id, document_id, input_ciphertext, input_digest,
        resolved_rules, rules_digest, result_bytes, result_digest,
        explanation_template_version, explanation_text, rule_version_ids,
        package_digests, supported, actor_id
      ) values (
        ${calculationId}, ${tenantId}, ${documentId}, ${Buffer.from([1])},
        ${'a'.repeat(64)}, ${tx.json({ fixture: true })}, ${'b'.repeat(64)},
        ${Buffer.from('{}')}, ${'c'.repeat(64)}, 'fixture-v1', 'Offline guard fixture',
        ARRAY[]::uuid[], ${[packageDigest]}::text[], true, 'tester:phase43'
      )`
      await tx`insert into fiscal_document_calculation_bindings (
        tenant_id, document_id, calculation_id
      ) values (${tenantId}, ${documentId}, ${calculationId})`
      await tx`insert into fiscal_document_readiness_bindings (
        tenant_id, document_id, capability_id, issuer_profile_revision,
        recipient_party_id, recipient_profile_revision, classification_revisions,
        origin_digest, reconciliation_digest
      ) values (
        ${tenantId}, ${documentId}, ${capability.id}, 1, ${randomUUID()}, 1,
        ${tx.json({})}, ${draftForGuard?.snapshot_digest}, ${'d'.repeat(64)}
      )`
      await tx`update fiscal_documents set status = 'ready'
        where tenant_id = ${tenantId} and id = ${documentId}`
    })
    expect(await documents.get(tenantId, documentId)).toMatchObject({ status: 'ready' })
    const grantId = randomUUID()
    const grantInput = {
      tenantId,
      documentId,
      grantId,
      capabilityId: capability.id,
      endpointDigest: 'b'.repeat(64),
      wsdlDigest: operations.wsdlDigest,
      certificateFingerprint: 'c'.repeat(64),
      issuedBy: 'operator:phase43',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    await ledger.grantDrill(grantInput)
    await ledger.grantDrill(grantInput)
    await ledger.assertResponseSchemas(
      tenantId,
      grantId,
      responseSchemas.documentDigest,
      responseSchemas.consultationDigest,
    )
    await expect(
      ledger.assertResponseSchemas(
        tenantId,
        grantId,
        '5'.repeat(64),
        responseSchemas.consultationDigest,
      ),
    ).rejects.toThrow('differ from reviewed homologation capability')
    expect(await ledger.drillContext(tenantId, documentId, grantId)).toMatchObject({
      drillGrantId: grantId,
      endpointDigest: grantInput.endpointDigest,
      wsdlDigest: grantInput.wsdlDigest,
      certificateFingerprint: grantInput.certificateFingerprint,
      adapterVersion: 'nfe55-sp-homologation-v1',
    })
    await expect(ledger.drillContext(randomUUID(), documentId, grantId)).rejects.toThrow(
      'Approved homologation drill is unavailable',
    )
    expect(await capabilities.getHomologationDrill(tenantId, documentId, grantId)).toMatchObject({
      id: capability.id,
      establishmentId: String(document?.establishment_id),
      calculationFixtureId: 'reviewed-sp-v1',
    })
    const issuance = new HomologationIssuance(
      appUrl,
      documents,
      projections,
      {
        readFrozen: async () => {
          throw new Error('calculation should not be read')
        },
      },
      capabilities,
      ledger,
      adapter,
      {
        certificate: Buffer.alloc(0),
        privateKey: Buffer.alloc(0),
        fingerprint: 'c'.repeat(64),
        issuerTaxId: '00000000E08G12',
        validUntil: Date.now() + 86_400_000,
        minimumRemainingMilliseconds: 0,
      },
      Buffer.alloc(0),
      'e'.repeat(64),
    )
    try {
      await expect(
        issuance.prepare({
          tenantId,
          documentId,
          drillGrantId: grantId,
          exchangeId: randomUUID(),
          actorId: 'operator:phase43',
        }),
      ).rejects.toThrow('Homologation schema, WSDL or certificate differs from drill')
      const [unreserved] = await administrator`select number from fiscal_number_reservations
        where tenant_id = ${tenantId} and document_id = ${documentId}`
      expect(unreserved).toBeUndefined()
    } finally {
      await issuance.close()
    }
    expect(await capabilities.getHomologationDrill(randomUUID(), documentId, grantId)).toBeNull()
    const rangeInput = {
      tenantId,
      capabilityId: capability.id,
      establishmentId: String(document?.establishment_id),
      series: 1,
      firstNumber: 710_000_001,
      lastNumber: 710_000_010,
      evidenceDigest: 'f'.repeat(64),
      reviewedBy: 'reviewer:phase43',
    }
    await expect(
      capabilities.registerHomologationNumberRange({
        ...rangeInput,
        reviewedBy: 'author:phase43',
      }),
    ).rejects.toThrow('independent capability reviewer')
    expect(await capabilities.registerHomologationNumberRange(rangeInput)).toMatchObject({
      existing: false,
    })
    expect(await capabilities.registerHomologationNumberRange(rangeInput)).toMatchObject({
      existing: true,
    })
    await expect(
      capabilities.registerHomologationNumberRange({ ...rangeInput, firstNumber: 1 }),
    ).rejects.toThrow('Conflicting immutable homologation number range')
    await expect(documents.reserveNumber(tenantId, documentId)).rejects.toThrow(
      'only in simulation',
    )
    const [reservedNumber, retriedNumber] = await Promise.all([
      documents.reserveHomologationNumber(tenantId, documentId, grantId),
      documents.reserveHomologationNumber(tenantId, documentId, grantId),
    ])
    expect(reservedNumber).toBe(rangeInput.firstNumber)
    expect(retriedNumber).toBe(reservedNumber)
    expect(await capabilities.registerHomologationNumberRange(rangeInput)).toMatchObject({
      existing: true,
    })
    await expect(administrator`update fiscal_number_counters
      set last_number = ${reservedNumber + 2}
      where tenant_id = ${tenantId} and establishment_id = ${rangeInput.establishmentId}
        and environment = 'homologation' and model = '55' and series = 1`).rejects.toThrow(
      'advance one number at a time',
    )
    await expect(administrator`insert into fiscal_number_reservations (
      tenant_id, document_id, establishment_id, environment, model, series,
      number, homologation_grant_id
    ) values (
      ${tenantId}, ${documentId}, ${rangeInput.establishmentId}, 'homologation',
      '55', 1, ${reservedNumber + 1}, ${grantId}
    )`).rejects.toThrow('lacks a valid reviewed range')
    await expect(administrator`insert into fiscal_number_reservations (
      tenant_id, document_id, establishment_id, environment, model, series,
      number, homologation_grant_id
    ) values (
      ${tenantId}, ${documentId}, ${rangeInput.establishmentId}, 'homologation',
      '55', 1, 999999999, ${grantId}
    )`).rejects.toThrow('lacks a valid reviewed range')
    await expect(
      documents.reserveHomologationNumber(tenantId, documentId, randomUUID()),
    ).rejects.toThrow('belongs to another drill')
    await expect(
      documents.reserveHomologationNumber(randomUUID(), documentId, grantId),
    ).rejects.toThrow('not found')
    await expect(
      ledger.grantDrill({ ...grantInput, grantId: randomUUID(), issuedBy: 'reviewer:phase43' }),
    ).rejects.toThrow('independent approved reviewer')
    const exchangeId = randomUUID()
    const input = {
      tenantId,
      documentId,
      exchangeId,
      drillGrantId: grantId,
      parentExchangeId: null,
      endpointDigest: 'b'.repeat(64),
      wsdlDigest: operations.wsdlDigest,
      certificateFingerprint: 'c'.repeat(64),
      adapterVersion: 'nfe55-sp-homologation-v1',
      actorId: 'tester:phase43',
    }
    await expect(
      ledger.prepare(
        {
          ...input,
          exchangeId: randomUUID(),
          drillGrantId: randomUUID(),
        },
        prepared,
      ),
    ).rejects.toThrow()
    const first = await ledger.prepare(input, prepared)
    expect(await ledger.prepare(input, prepared)).toEqual(first)
    const reopened = await ledger.loadPrepared(tenantId, exchangeId, operations, 'tester:resume')
    expect(reopened.stage).toBe('prepared')
    expect(reopened.prepared.request).toEqual(prepared.request)
    expect(reopened.input).toMatchObject({ ...input, actorId: 'tester:resume' })
    await expect(
      ledger.loadPrepared(randomUUID(), exchangeId, operations, 'tester:resume'),
    ).rejects.toThrow('SEFAZ exchange not found')
    await expect(
      ledger.loadPrepared(
        tenantId,
        exchangeId,
        { ...operations, wsdlDigest: 'f'.repeat(64) },
        'tester:resume',
      ),
    ).rejects.toThrow('WSDL differs')
    await expect(
      ledger.prepare({ ...input, endpointDigest: 'd'.repeat(64) }, prepared),
    ).rejects.toThrow('SEFAZ exchange differs from approved drill grant')
    expect(await ledger.markStarted(tenantId, exchangeId, 'worker-a')).toBe(true)
    expect(await ledger.markStarted(tenantId, exchangeId, 'worker-b')).toBe(false)
    expect(
      (await ledger.loadPrepared(tenantId, exchangeId, operations, 'tester:resume')).stage,
    ).toBe('send_started')
    const soap = Buffer.from(
      `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
        `<nfeStatusServicoNFResponse xmlns="${operationNamespace}"><nfeResultMsg>` +
        `<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
        '<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><cStat>107</cStat>' +
        '<xMotivo>Servico em operacao</xMotivo><cUF>35</cUF>' +
        '<dhRecbto>2026-09-23T12:00:00-03:00</dhRecbto></retConsStatServ>' +
        '</nfeResultMsg></nfeStatusServicoNFResponse></s:Body></s:Envelope>',
    )
    const rawDigest = await ledger.recordRawResponse(tenantId, documentId, exchangeId, soap)
    expect(await ledger.recordRawResponse(tenantId, documentId, exchangeId, soap)).toBe(rawDigest)
    const rawRecovery = new HomologationRawRecovery(ledger, adapter, responseSchemas)
    expect(
      (await ledger.loadPrepared(tenantId, exchangeId, operations, 'tester:resume')).stage,
    ).toBe('raw_unparsed')
    await expect(
      new HomologationRawRecovery(ledger, adapter, {
        validate: responseSchemas.validate.bind(responseSchemas),
        documentDigest: responseSchemas.documentDigest,
        consultationDigest: '5'.repeat(64),
      }).reparse(tenantId, exchangeId, 'tester:resume', operations),
    ).rejects.toThrow('response schemas differ')
    await expect(
      new HomologationRawRecovery(
        ledger,
        {
          parseResponse: adapter.parseResponse.bind(adapter),
          wsdlDigest: adapter.wsdlDigest,
          adapterVersion: 'nfe55-sp-homologation-v2',
        },
        responseSchemas,
      ).reparse(tenantId, exchangeId, 'tester:resume', operations),
    ).rejects.toThrow('runtime binding differs')
    expect(
      (await rawRecovery.reparse(tenantId, exchangeId, 'tester:resume', operations)).statusCode,
    ).toBe('107')
    await expect(
      rawRecovery.reparse(tenantId, exchangeId, 'tester:resume', operations),
    ).rejects.toThrow('no unparsed stored response')
    expect(
      (await ledger.loadPrepared(tenantId, exchangeId, operations, 'tester:resume')).stage,
    ).toBe('observed')
    const [row] = await administrator`select raw.response_digest, parsed.cstat,
        parsed.response_digest as parsed_digest, parsed.decision, parsed.decision_version
      from fiscal_homologation_raw_responses raw
      join fiscal_homologation_parsed_responses parsed using (tenant_id, exchange_id)
      where raw.tenant_id = ${tenantId} and raw.exchange_id = ${exchangeId}`
    expect(row).toMatchObject({
      response_digest: rawDigest,
      parsed_digest: rawDigest,
      cstat: '107',
      decision: 'available',
      decision_version: 'nfe55-sp-homologation-decision-v1',
    })
    await expect(administrator`insert into fiscal_homologation_parsed_responses (
      tenant_id, exchange_id, response_digest, cstat, decision
    ) values (${tenantId}, ${exchangeId}, ${rawDigest}, '107', 'authorized')`).rejects.toThrow(
      'Authorized decision lacks SEFAZ protocol evidence',
    )
    await expect(
      ledger.recordRawResponse(tenantId, documentId, exchangeId, Buffer.from('another response')),
    ).rejects.toThrow('Conflicting immutable SEFAZ response')
    let sends = 0
    const runner = new HomologationExchangeRunner(
      ledger,
      {
        endpointSetDigest: input.endpointDigest,
        certificateFingerprint: input.certificateFingerprint,
        async send() {
          sends += 1
          return soap
        },
      },
      adapter,
      responseSchemas,
    )
    const runInput = { ...input, exchangeId: randomUUID(), workerId: 'worker-a' }
    await expect(
      new HomologationExchangeRunner(
        ledger,
        {
          endpointSetDigest: input.endpointDigest,
          certificateFingerprint: input.certificateFingerprint,
          async send() {
            sends += 1
            return soap
          },
        },
        adapter,
        {
          validate: responseSchemas.validate.bind(responseSchemas),
          documentDigest: '5'.repeat(64),
          consultationDigest: responseSchemas.consultationDigest,
        },
      ).execute(runInput, prepared),
    ).rejects.toThrow('response schemas differ')
    expect(sends).toBe(0)
    await expect(
      runner.execute({ ...runInput, endpointDigest: 'd'.repeat(64) }, prepared),
    ).rejects.toThrow('runtime binding differs')
    await expect(
      runner.execute({ ...runInput, adapterVersion: 'nfe55-sp-homologation-v2' }, prepared),
    ).rejects.toThrow('runtime binding differs')
    expect(sends).toBe(0)
    const { workerId: _workerId, ...storedRunInput } = runInput
    await ledger.prepare(storedRunInput, prepared)
    await expect(
      new HomologationExchangeRunner(
        ledger,
        {
          endpointSetDigest: input.endpointDigest,
          certificateFingerprint: input.certificateFingerprint,
          async send() {
            sends += 1
            return soap
          },
        },
        {
          parseResponse: adapter.parseResponse.bind(adapter),
          wsdlDigest: adapter.wsdlDigest,
          adapterVersion: 'nfe55-sp-homologation-v2',
        },
        responseSchemas,
      ).resume(
        {
          tenantId,
          exchangeId: runInput.exchangeId,
          workerId: 'worker-a',
          actorId: 'tester:resume',
        },
        operations,
      ),
    ).rejects.toThrow('runtime binding differs')
    expect(sends).toBe(0)
    expect(
      (
        await runner.resume(
          {
            tenantId,
            exchangeId: runInput.exchangeId,
            workerId: 'worker-a',
            actorId: 'tester:resume',
          },
          operations,
        )
      ).statusCode,
    ).toBe('107')
    await expect(runner.execute(runInput, prepared)).rejects.toBeInstanceOf(
      UncertainSefazOutcomeError,
    )
    expect(sends).toBe(1)
    const malformedRunner = new HomologationExchangeRunner(
      ledger,
      {
        endpointSetDigest: input.endpointDigest,
        certificateFingerprint: input.certificateFingerprint,
        async send() {
          return Buffer.from('<invalid>')
        },
      },
      adapter,
      responseSchemas,
    )
    const malformedInput = { ...input, exchangeId: randomUUID(), workerId: 'worker-a' }
    await expect(malformedRunner.execute(malformedInput, prepared)).rejects.toThrow()
    const [rawOnly] = await administrator`select raw.response_digest, parsed.cstat
      from fiscal_homologation_raw_responses raw
      left join fiscal_homologation_parsed_responses parsed using (tenant_id, exchange_id)
      where raw.tenant_id = ${tenantId} and raw.exchange_id = ${malformedInput.exchangeId}`
    expect(rawOnly?.response_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(rawOnly?.cstat).toBeNull()
    const schemaFailure = { ...input, exchangeId: randomUUID(), workerId: 'worker-a' }
    const schemaFailureRunner = new HomologationExchangeRunner(
      ledger,
      {
        endpointSetDigest: input.endpointDigest,
        certificateFingerprint: input.certificateFingerprint,
        async send() {
          return Buffer.from(soap.toString().replace('<verAplic>SP-v1</verAplic>', ''))
        },
      },
      adapter,
      responseSchemas,
    )
    await expect(schemaFailureRunner.execute(schemaFailure, prepared)).rejects.toThrow(
      'schema validation failed',
    )
    const [schemaRaw] = await administrator`select raw.response_digest, parsed.cstat
      from fiscal_homologation_raw_responses raw
      left join fiscal_homologation_parsed_responses parsed using (tenant_id, exchange_id)
      where raw.tenant_id = ${tenantId} and raw.exchange_id = ${schemaFailure.exchangeId}`
    expect(schemaRaw?.response_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(schemaRaw?.cstat).toBeNull()
    const listed = await artifacts.listV2(tenantId, documentId)
    expect(fiscalArtifactListV2Schema.safeParse(listed).success).toBe(true)
    expect(listed).toMatchObject({ environment: 'homologation', fiscalValue: false })
    expect(listed?.artifacts.map((artifact) => artifact.kind)).toContain('homologation_request')
    expect(listed?.artifacts.map((artifact) => artifact.kind)).toContain('homologation_response')
    expect(
      listed?.artifacts.every((artifact) => !artifact.simulated && !artifact.fiscalValue),
    ).toBe(true)
    expect(await artifacts.list(tenantId, documentId)).toBeNull()

    const accessKey = buildNfe55AccessKey({
      issuerUfCode: '35',
      issuedOn: '2026-09-23',
      issuerTaxId: '00000000E08G12',
      model: '55',
      series: 1,
      number: reservedNumber,
      emissionType: 1,
      numericCode: '12345678',
    })
    const authorizationId = randomUUID()
    const signedXml = Buffer.from(
      `<NFe><infNFe Id="NFe${accessKey}"><ide><serie>1</serie><nNF>${reservedNumber}</nNF>` +
        '<dhEmi>2026-09-23T12:00:00-03:00</dhEmi></ide>' +
        '<emit><CNPJ>00000000E08G12</CNPJ><xNome>Emitente offline</xNome></emit>' +
        '<dest><CNPJ>11111111111111</CNPJ><xNome>Destinatario offline</xNome></dest>' +
        '<det><prod><cProd>A</cProd><xProd>Cafe</xProd><qCom>1</qCom>' +
        '<vUnCom>10.00</vUnCom><vProd>10.00</vProd></prod></det>' +
        '<total><ICMSTot><vProd>10.00</vProd><vNF>10.00</vNF></ICMSTot></total>' +
        '</infNFe></NFe>',
    )
    const authorization = {
      service: 'authorization' as const,
      request: Buffer.from(`<prepared-authorization>${signedXml}</prepared-authorization>`),
      operation: 'nfeAutorizacaoLote',
      operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
      expectedAccessKey: accessKey,
    }
    const authorizationInput = {
      service: 'authorization' as const,
      lotId: '1',
      accessKey,
      signedXml,
      schemaZip: Buffer.alloc(0),
      schemaDigest: 'e'.repeat(64),
    }
    const authorizationAdapter = {
      adapterVersion: adapter.adapterVersion,
      wsdlDigest: operations.wsdlDigest,
      certificateFingerprint: input.certificateFingerprint,
      async prepare() {
        return authorization
      },
    }
    await expect(
      ledger.prepare({ ...input, exchangeId: authorizationId }, authorization),
    ).rejects.toThrow('requires the bound signed document and envelope')
    await expect(
      ledger.bindAuthorization({ ...input, exchangeId: authorizationId }, authorizationInput, {
        ...authorizationAdapter,
        certificateFingerprint: 'd'.repeat(64),
      }),
    ).rejects.toThrow('signing certificate differs from drill')
    await expect(
      ledger.bindAuthorization({ ...input, exchangeId: authorizationId }, authorizationInput, {
        ...authorizationAdapter,
        adapterVersion: 'nfe55-sp-homologation-v2',
      }),
    ).rejects.toThrow('adapter version differs from drill')
    const bound = await ledger.bindAuthorization(
      { ...input, exchangeId: authorizationId },
      authorizationInput,
      authorizationAdapter,
    )
    expect(bound).toMatchObject({ prepared: authorization })
    const preAuthorizationDanfe = new HomologationDanfe(appUrl, artifacts)
    try {
      await expect(preAuthorizationDanfe.render(tenantId, documentId)).rejects.toThrow(
        'Unique authorized homologation protocol is unavailable',
      )
    } finally {
      await preAuthorizationDanfe.close()
    }
    expect(
      await ledger.bindAuthorization(
        { ...input, exchangeId: authorizationId },
        authorizationInput,
        authorizationAdapter,
      ),
    ).toEqual(bound)
    const wrongNumberKey = buildNfe55AccessKey({
      issuerUfCode: '35',
      issuedOn: '2026-09-23',
      issuerTaxId: '00000000E08G12',
      model: '55',
      series: 1,
      number: reservedNumber + 1,
      emissionType: 1,
      numericCode: '12345678',
    })
    await expect(administrator`insert into fiscal_homologation_authorization_bindings (
      tenant_id, document_id, drill_grant_id, access_key, number,
      signed_xml_digest, request_digest, schema_digest
    ) values (
      ${tenantId}, ${documentId}, ${grantId}, ${wrongNumberKey}, ${reservedNumber},
      ${bound.signedXmlDigest}, ${bound.requestDigest}, ${authorizationInput.schemaDigest}
    )`).rejects.toThrow('differs from document, drill or number')
    await expect(
      ledger.bindAuthorization(
        { ...input, exchangeId: authorizationId },
        { ...authorizationInput, signedXml: Buffer.from('<NFe>different</NFe>') },
        authorizationAdapter,
      ),
    ).rejects.toThrow('does not contain the signed NF-e bytes')
    await ledger.prepare({ ...input, exchangeId: authorizationId }, authorization)
    await expect(ledger.cancellationTarget(tenantId, documentId, randomUUID())).rejects.toThrow(
      'Unique authorized homologation protocol is unavailable',
    )
    await expect(ledger.recoveryTarget(tenantId, documentId)).rejects.toThrow('No started')
    expect(await ledger.markStarted(tenantId, authorizationId, 'worker-a')).toBe(true)
    await expect(
      ledger.prepare({ ...input, exchangeId: randomUUID() }, authorization),
    ).rejects.toThrow('Conflicting immutable SEFAZ exchange')
    expect(await ledger.recoveryTarget(tenantId, documentId)).toMatchObject({
      service: 'protocol',
      parentExchangeId: authorizationId,
      accessKey,
    })
    const consultationSoap = (operation: string, service: string, payload: string) =>
      Buffer.from(
        `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>` +
          `<${operation}Response xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${service}">` +
          `<nfeResultMsg>${payload}</nfeResultMsg></${operation}Response></s:Body></s:Envelope>`,
      )
    const protocolSoap = consultationSoap(
      'nfeConsultaNF',
      'NFeConsultaProtocolo4',
      `<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
        '<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><cStat>217</cStat>' +
        '<xMotivo>Sem protocolo nesta consulta</xMotivo><cUF>35</cUF>' +
        `<dhRecbto>2026-09-23T12:00:00-03:00</dhRecbto><chNFe>${accessKey}</chNFe>` +
        '</retConsSitNFe>',
    )
    const protocolRunner = new HomologationExchangeRunner(
      ledger,
      {
        endpointSetDigest: input.endpointDigest,
        certificateFingerprint: input.certificateFingerprint,
        async send() {
          return protocolSoap
        },
      },
      adapter,
      responseSchemas,
    )
    const protocolRecovery = new HomologationRecovery(ledger, adapter, protocolRunner)
    const protocolConsultation = { ...input, exchangeId: randomUUID(), workerId: 'worker-a' }
    expect((await protocolRecovery.consult(protocolConsultation)).service).toBe('protocol')

    const receipt = '123456789012345'
    const authorizationSoap = consultationSoap(
      'nfeAutorizacaoLote',
      'NFeAutorizacao4',
      `<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
        `<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><cStat>103</cStat>` +
        `<xMotivo>Lote recebido</xMotivo><cUF>35</cUF>` +
        '<dhRecbto>2026-09-23T12:00:00-03:00</dhRecbto>' +
        `<infRec><nRec>${receipt}</nRec><tMed>1</tMed></infRec></retEnviNFe>`,
    )
    await ledger.recordRawResponse(tenantId, documentId, authorizationId, authorizationSoap)
    const parsedAuthorization = adapter.parseResponse(authorization, authorizationSoap)
    await ledger.recordParsedResponse(tenantId, documentId, authorizationId, parsedAuthorization)
    const observationsOutbox = await administrator`select event_id, payload from fiscal_outbox
      where tenant_id = ${tenantId}
        and event_type = ${fiscalDocumentHomologationObserved.type}
        and payload->>'exchangeId' = ${authorizationId}`
    expect(observationsOutbox).toHaveLength(1)
    expect(
      fiscalDocumentHomologationObserved.payload.parse(observationsOutbox[0]?.payload),
    ).toMatchObject({
      documentId,
      exchangeId: authorizationId,
      service: 'authorization',
      environment: 'homologation',
      fiscalValue: false,
      decision: 'pending',
    })
    await ledger.recordParsedResponse(tenantId, documentId, authorizationId, parsedAuthorization)
    const [observationCount] = await administrator`select count(*)::integer as count
      from fiscal_outbox where tenant_id = ${tenantId}
        and event_type = ${fiscalDocumentHomologationObserved.type}
        and payload->>'exchangeId' = ${authorizationId}`
    expect(observationCount?.count).toBe(1)
    const [authorizationDecision] = await administrator`select decision
      from fiscal_homologation_parsed_responses
      where tenant_id = ${tenantId} and exchange_id = ${authorizationId}`
    expect(authorizationDecision?.decision).toBe('pending')
    expect(await ledger.recoveryTarget(tenantId, documentId)).toMatchObject({
      service: 'receipt',
      parentExchangeId: authorizationId,
      accessKey,
      receipt,
    })
    const wrongReceipt = await adapter.prepare({
      service: 'receipt',
      accessKey,
      receipt: '999999999999999',
    })
    await expect(
      ledger.prepare(
        {
          ...input,
          exchangeId: randomUUID(),
          parentExchangeId: authorizationId,
        },
        wrongReceipt,
      ),
    ).rejects.toThrow('receipt differs')
    const otherKey = buildNfe55AccessKey({
      issuerUfCode: '35',
      issuedOn: '2026-09-23',
      issuerTaxId: '00000000E08G12',
      model: '55',
      series: 1,
      number: reservedNumber,
      emissionType: 1,
      numericCode: '87654321',
    })
    const wrongProtocol = await adapter.prepare({ service: 'protocol', accessKey: otherKey })
    await expect(
      ledger.prepare(
        {
          ...input,
          exchangeId: randomUUID(),
          parentExchangeId: authorizationId,
        },
        wrongProtocol,
      ),
    ).rejects.toThrow('does not match a started authorization')
    const receiptSoap = consultationSoap(
      'nfeRetAutorizacaoLote',
      'NFeRetAutorizacao4',
      `<retConsReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
        `<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><nRec>${receipt}</nRec>` +
        '<cStat>105</cStat><xMotivo>Em processamento</xMotivo><cUF>35</cUF>' +
        '<dhRecbto>2026-09-23T12:00:00-03:00</dhRecbto></retConsReciNFe>',
    )
    const receiptRunner = new HomologationExchangeRunner(
      ledger,
      {
        endpointSetDigest: input.endpointDigest,
        certificateFingerprint: input.certificateFingerprint,
        async send() {
          return receiptSoap
        },
      },
      adapter,
      responseSchemas,
    )
    const receiptRecovery = new HomologationRecovery(ledger, adapter, receiptRunner)
    const receiptConsultation = {
      ...input,
      exchangeId: randomUUID(),
      workerId: 'worker-a',
    }
    expect((await receiptRecovery.consult(receiptConsultation)).service).toBe('receipt')
    const [receiptDecision] = await administrator`select decision
      from fiscal_homologation_parsed_responses
      where tenant_id = ${tenantId} and exchange_id = ${receiptConsultation.exchangeId}`
    expect(receiptDecision?.decision).toBe('pending')
    await expect(
      administrator.begin(async (tx) => {
        for (let attempt = 0; attempt < 9; attempt += 1)
          await tx`insert into fiscal_homologation_exchanges (
            id, tenant_id, document_id, drill_grant_id, parent_exchange_id, service,
            request_digest, endpoint_digest, wsdl_digest, certificate_fingerprint,
            adapter_version, access_key, receipt
          ) select ${randomUUID()}, tenant_id, document_id, drill_grant_id,
            parent_exchange_id, service, request_digest, endpoint_digest, wsdl_digest,
            certificate_fingerprint, adapter_version, access_key, receipt
          from fiscal_homologation_exchanges
          where tenant_id = ${tenantId} and id = ${protocolConsultation.exchangeId}`
      }),
    ).rejects.toThrow('consultation budget exhausted')
    const cancellationProtocol = '123456789012345'
    const cancellationEvent = {
      service: 'event' as const,
      request: Buffer.from('<prepared-cancellation/>'),
      operation: 'nfeRecepcaoEvento',
      operationNamespace: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4',
      expectedAccessKey: accessKey,
      expectedAuthorizationProtocol: cancellationProtocol,
    }
    const eventInput = {
      ...input,
      exchangeId: randomUUID(),
      parentExchangeId: authorizationId,
    }
    await expect(ledger.prepare(eventInput, cancellationEvent)).rejects.toThrow(
      'requires the exact authorized protocol',
    )
    const authorizedSoap = consultationSoap(
      'nfeConsultaNF',
      'NFeConsultaProtocolo4',
      `<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
        '<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><cStat>100</cStat>' +
        '<xMotivo>Autorizado</xMotivo><cUF>35</cUF>' +
        '<dhRecbto>2026-09-23T12:00:00-03:00</dhRecbto>' +
        `<chNFe>${accessKey}</chNFe><protNFe versao="4.00"><infProt>` +
        `<tpAmb>2</tpAmb><verAplic>SP-v1</verAplic><chNFe>${accessKey}</chNFe>` +
        '<dhRecbto>2026-09-23T12:00:00-03:00</dhRecbto>' +
        `<nProt>${cancellationProtocol}</nProt><cStat>100</cStat>` +
        '<xMotivo>Autorizado</xMotivo></infProt></protNFe></retConsSitNFe>',
    )
    const authorizedRunner = new HomologationExchangeRunner(
      ledger,
      {
        endpointSetDigest: input.endpointDigest,
        certificateFingerprint: input.certificateFingerprint,
        async send() {
          return authorizedSoap
        },
      },
      adapter,
      responseSchemas,
    )
    const authorizedPrepared = await adapter.prepare({ service: 'protocol', accessKey })
    const staleConsultationId = randomUUID()
    await ledger.prepare(
      { ...input, exchangeId: staleConsultationId, parentExchangeId: authorizationId },
      authorizedPrepared,
    )
    const authorizedConsultation = {
      ...input,
      exchangeId: randomUUID(),
      parentExchangeId: authorizationId,
      workerId: 'worker-a',
    }
    expect(
      (await authorizedRunner.execute(authorizedConsultation, authorizedPrepared))
        .documentStatusCode,
    ).toBe('100')
    const [authorizedDecision] = await administrator`select decision, protocol_number
      from fiscal_homologation_parsed_responses
      where tenant_id = ${tenantId} and exchange_id = ${authorizedConsultation.exchangeId}`
    expect(authorizedDecision).toMatchObject({
      decision: 'authorized',
      protocol_number: cancellationProtocol,
    })
    const authorizedDanfe = new HomologationDanfe(appUrl, artifacts)
    try {
      const rendered = await authorizedDanfe.render(tenantId, documentId)
      expect(rendered.exchangeId).toBe(authorizedConsultation.exchangeId)
      expect(await authorizedDanfe.render(tenantId, documentId)).toEqual(rendered)
      const artifact = await artifacts.getV2(tenantId, documentId, 'danfe', rendered.digest)
      expect(artifact.metadata).toMatchObject({
        environment: 'homologation',
        sourceSchema: 'horizon-danfe-homologation-v1',
      })
      expect((await PDFDocument.load(artifact.bytes)).getTitle()).toContain('SEM VALOR FISCAL')
    } finally {
      await authorizedDanfe.close()
    }
    expect(
      await ledger.cancellationTarget(tenantId, documentId, eventInput.exchangeId),
    ).toMatchObject({
      parentExchangeId: authorizationId,
      accessKey,
      protocolNumber: cancellationProtocol,
      capabilityId: capability.id,
    })
    await expect(ledger.recoveryTarget(tenantId, documentId)).rejects.toThrow(
      'terminal homologation decision',
    )
    await expect(ledger.markStarted(tenantId, staleConsultationId, 'worker-b')).rejects.toThrow(
      'terminal homologation decision',
    )
    await expect(
      ledger.prepare(
        { ...input, exchangeId: randomUUID(), parentExchangeId: authorizationId },
        authorizedPrepared,
      ),
    ).rejects.toThrow('terminal homologation decision')
    await expect(
      ledger.prepare(
        { ...eventInput, exchangeId: randomUUID() },
        { ...cancellationEvent, expectedAuthorizationProtocol: '999999999999999' },
      ),
    ).rejects.toThrow('requires the exact authorized protocol')
    const certificatePath = join(artifactRoot, `${eventInput.exchangeId}.cert.pem`)
    const privateKeyPath = join(artifactRoot, `${eventInput.exchangeId}.key.pem`)
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Horizon Phase 43 Cancellation Test Only',
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
    ])
    const signingCredential = {
      certificate: await readFile(certificatePath),
      privateKey: await readFile(privateKeyPath),
      fingerprint: input.certificateFingerprint,
      issuerTaxId: '00000000E08G12',
      validUntil: Date.now() + 86_400_000,
      minimumRemainingMilliseconds: 0,
    }
    const signingAdapter = new SefazNfe55HomologationAdapter(signingCredential, operations, 'SP')
    const cancellation = new HomologationCancellation(
      ledger,
      capabilities,
      {
        prepare: signingAdapter.prepare.bind(signingAdapter),
        adapterVersion: signingAdapter.adapterVersion,
        wsdlDigest: signingAdapter.wsdlDigest,
        certificateFingerprint: input.certificateFingerprint,
      },
      signingCredential,
      await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
    )
    const cancellationCommand = {
      tenantId,
      documentId,
      exchangeId: eventInput.exchangeId,
      actorId: 'tester:phase43',
      reason: 'Cancelamento solicitado pelo emitente',
      occurredAt: '2026-09-23T17:00:00-03:00',
    }
    await expect(
      new HomologationCancellation(
        ledger,
        capabilities,
        {
          prepare: signingAdapter.prepare.bind(signingAdapter),
          adapterVersion: 'nfe55-sp-homologation-v2',
          wsdlDigest: signingAdapter.wsdlDigest,
          certificateFingerprint: input.certificateFingerprint,
        },
        signingCredential,
        await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
      ).prepare(cancellationCommand),
    ).rejects.toThrow('runtime differs from authorization')
    const cancellationResult = await cancellation.prepare(cancellationCommand)
    expect(cancellationResult).toMatchObject({
      exchangeId: eventInput.exchangeId,
      accessKey,
      authorizationProtocol: cancellationProtocol,
    })
    expect(await cancellation.prepare(cancellationCommand)).toEqual(cancellationResult)
    expect(
      await ledger.cancellationTarget(tenantId, documentId, eventInput.exchangeId),
    ).toMatchObject({ protocolNumber: cancellationProtocol })
    await expect(ledger.cancellationTarget(tenantId, documentId, randomUUID())).rejects.toThrow(
      'Unique authorized homologation protocol is unavailable',
    )
    const history = await observations.list(tenantId, documentId)
    expect(history.find((row) => row.exchangeId === exchangeId)).toMatchObject({
      service: 'status',
      stage: 'observed',
      decision: 'available',
      responseDigest: rawDigest,
    })
    expect(history.find((row) => row.exchangeId === malformedInput.exchangeId)).toMatchObject({
      stage: 'raw_unparsed',
      decision: 'unknown',
    })
    expect(history.find((row) => row.exchangeId === authorizationId)).toMatchObject({
      stage: 'observed',
      decision: 'pending',
      receipt,
    })
    expect(
      history.find((row) => row.exchangeId === authorizedConsultation.exchangeId),
    ).toMatchObject({
      stage: 'observed',
      decision: 'authorized',
      protocolNumber: cancellationProtocol,
    })
    expect(history.find((row) => row.exchangeId === eventInput.exchangeId)).toMatchObject({
      stage: 'prepared',
      decision: 'unknown',
    })
    const restoreVerifier = new HomologationRestoreVerifier(appUrl, artifacts, observations)
    try {
      const verified = await restoreVerifier.verify(tenantId, documentId)
      expect(verified.exchanges).toBe(history.length)
      expect(verified.artifacts).toBeGreaterThan(history.length)
      const [storedArtifact] = await administrator`select object_key from fiscal_artifacts
        where tenant_id = ${tenantId} and document_id = ${documentId}
          and kind = 'homologation_request' and digest = ${bound.signedXmlDigest}`
      if (!storedArtifact) throw new Error('Offline restore fixture lacks signed XML')
      const objectPath = join(artifactRoot, String(storedArtifact.object_key))
      const encryptedBytes = await readFile(objectPath)
      await rm(objectPath)
      try {
        await expect(restoreVerifier.verify(tenantId, documentId)).rejects.toThrow()
      } finally {
        await writeFile(objectPath, encryptedBytes)
      }
      expect((await restoreVerifier.verify(tenantId, documentId)).artifacts).toBe(
        verified.artifacts,
      )
      await expect(restoreVerifier.verify(randomUUID(), documentId)).rejects.toThrow(
        'Homologation restore document is unavailable',
      )
    } finally {
      await restoreVerifier.close()
    }
    expect(await observations.list(randomUUID(), documentId)).toEqual([])
    const loadedCancellation = await ledger.loadPrepared(
      tenantId,
      eventInput.exchangeId,
      operations,
      'tester:phase43',
    )
    const eventSoap = consultationSoap(
      'nfeRecepcaoEvento',
      'NFeRecepcaoEvento4',
      `<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">` +
        '<idLote>1</idLote><tpAmb>2</tpAmb><verAplic>SP-v1</verAplic>' +
        '<cOrgao>35</cOrgao><cStat>128</cStat><xMotivo>Lote processado</xMotivo>' +
        '<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>SP-v1</verAplic>' +
        '<cOrgao>35</cOrgao><cStat>135</cStat>' +
        `<xMotivo>Evento registrado</xMotivo><chNFe>${accessKey}</chNFe>` +
        '<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento>' +
        '<dhRegEvento>2026-09-23T17:00:00-03:00</dhRegEvento>' +
        `<nProt>${cancellationProtocol}</nProt></infEvento></retEvento></retEnvEvento>`,
    )
    const parsedEvent = adapter.parseResponse(loadedCancellation.prepared, eventSoap)
    await responseSchemas.validate('event', parsedEvent.payload)
    expect(await ledger.markStarted(tenantId, eventInput.exchangeId, 'worker-a')).toBe(true)
    await ledger.recordRawResponse(tenantId, documentId, eventInput.exchangeId, eventSoap)
    await ledger.recordParsedResponse(tenantId, documentId, eventInput.exchangeId, parsedEvent)
    const liveShapeEvidence = {
      tenantId,
      capabilityId: capability.id,
      sourceManifestDigest: 'd'.repeat(64),
      endpointSetDigest: input.endpointDigest,
      certificateFingerprint: input.certificateFingerprint,
      roundTripDigest: canonicalDigest({
        authorizationId,
        consultationId: authorizedConsultation.exchangeId,
        cancellationId: eventInput.exchangeId,
      }),
      authorizationExchangeId: authorizationId,
      consultationExchangeId: authorizedConsultation.exchangeId,
      cancellationExchangeId: eventInput.exchangeId,
      reviewedBy: 'reviewer:phase43',
      reviewedAt: new Date().toISOString(),
    }
    await expect(
      capabilities.recordHomologationEvidence({
        ...liveShapeEvidence,
        consultationExchangeId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: '23514' })
    expect(await capabilities.recordHomologationEvidence(liveShapeEvidence)).toMatchObject({
      existing: false,
    })
    expect(await capabilities.recordHomologationEvidence(liveShapeEvidence)).toMatchObject({
      existing: true,
    })
    const preactivationExchangeId = randomUUID()
    await ledger.prepare({ ...input, exchangeId: preactivationExchangeId }, prepared)
    expect(await ledger.nextPreparedForActive(tenantId)).toBeNull()
    await capabilities.change({
      tenantId,
      capabilityId: capability.id,
      action: 'activate_homologated',
      evidenceDigest: liveShapeEvidence.roundTripDigest,
      actorId: 'release:phase43',
      reason: 'Offline structural activation fixture only',
      occurredAt: new Date().toISOString(),
    })
    expect(await capabilities.listActive(tenantId)).toEqual([
      expect.objectContaining({ id: capability.id, status: 'homologated' }),
    ])
    expect(await ledger.nextPreparedForActive(tenantId)).toBeNull()
    const queuedAfterReviewId = randomUUID()
    await ledger.prepare({ ...input, exchangeId: queuedAfterReviewId }, prepared)
    expect(await ledger.nextPreparedForActive(tenantId)).toBe(queuedAfterReviewId)
    const activeWorker = new HomologationExchangeWorker(ledger, runner, operations)
    expect(await activeWorker.processOne(randomUUID(), 'worker-a')).toBe(false)
    expect(await activeWorker.processOne(tenantId, 'worker-a')).toBe(true)
    expect(await ledger.nextPreparedForActive(tenantId)).toBeNull()
    expect(await activeWorker.processOne(tenantId, 'worker-a')).toBe(false)
    expect(
      (await ledger.loadPrepared(tenantId, queuedAfterReviewId, operations, 'tester:phase43'))
        .stage,
    ).toBe('observed')
    const pendingStatusId = randomUUID()
    await ledger.prepare({ ...input, exchangeId: pendingStatusId }, prepared)
    expect(await ledger.markStarted(tenantId, pendingStatusId, 'worker-a')).toBe(true)
    const rawOnlyStatusId = randomUUID()
    await ledger.prepare({ ...input, exchangeId: rawOnlyStatusId }, prepared)
    expect(await ledger.markStarted(tenantId, rawOnlyStatusId, 'worker-a')).toBe(true)
    await ledger.recordRawResponse(tenantId, documentId, rawOnlyStatusId, soap)
    const stoppedExchangeId = randomUUID()
    await ledger.prepare({ ...input, exchangeId: stoppedExchangeId }, prepared)
    await capabilities.change({
      tenantId,
      capabilityId: capability.id,
      action: 'deactivate',
      evidenceDigest: liveShapeEvidence.roundTripDigest,
      actorId: 'release:phase43',
      reason: 'Offline worker deactivation fixture',
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
    })
    expect(await ledger.nextPreparedForActive(tenantId)).toBeNull()
    expect(await activeWorker.processOne(tenantId, 'worker-a')).toBe(false)
    await expect(ledger.markStarted(tenantId, stoppedExchangeId, 'worker-a')).rejects.toThrow(
      'deactivated before transmission',
    )
    await verifyRestoredHomologationLedger({
      tenantId,
      documentId,
      pendingStatusId,
      rawOnlyStatusId,
      operations,
      adapter,
      responseSchemas,
      endpointDigest: input.endpointDigest,
      certificateFingerprint: input.certificateFingerprint,
      sourceObservations: observations,
      sourceArtifacts: artifacts,
    })
    const [documentAfterObservation] = await administrator`select status, environment
      from fiscal_documents where tenant_id = ${tenantId} and id = ${documentId}`
    expect(documentAfterObservation).toMatchObject({ status: 'ready', environment: 'homologation' })
  } finally {
    await Promise.all([
      ledger.close(),
      artifacts.close(),
      capabilities.close(),
      observations.close(),
    ])
  }
}

async function verifyRestoredHomologationLedger(input: {
  tenantId: string
  documentId: string
  pendingStatusId: string
  rawOnlyStatusId: string
  operations: SefazOperationMap
  adapter: SefazNfe55HomologationAdapter
  responseSchemas: SefazResponseSchemaValidator
  endpointDigest: string
  certificateFingerprint: string
  sourceObservations: HomologationObservations
  sourceArtifacts: FiscalArtifacts
}): Promise<void> {
  const backupPath = '/tmp/fiscal-phase43-backup.dump'
  const backup = await container.exec(
    [
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--file',
      backupPath,
      '-U',
      'postgres',
      '-d',
      'horizon_fiscal_test',
    ],
    { env: { PGPASSWORD: 'test' } },
  )
  if (backup.exitCode !== 0) throw new Error(`Phase 43 pg_dump failed: ${backup.stderr}`)
  const restoredDirectory = await mkdtemp(join(tmpdir(), 'horizon-phase43-restored-'))
  const restoredObjects = join(restoredDirectory, 'objects')
  let restoredContainer: StartedPostgreSqlContainer | null = null
  try {
    await cp(artifactRoot, restoredObjects, { recursive: true })
    restoredContainer = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_phase43_restored_test')
      .withUsername('postgres')
      .withPassword('test')
      .start()
    await restoredContainer.copyArchiveToContainer(
      (await container.copyArchiveFromContainer(backupPath)) as Readable,
      '/tmp',
    )
    const restoredAdmin = postgres(restoredContainer.getConnectionUri(), { max: 1 })
    try {
      await restoredAdmin.unsafe(
        `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
         CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`,
        [],
        { prepare: false },
      )
      const restore = await restoredContainer.exec(
        [
          'pg_restore',
          '--no-owner',
          '-U',
          'postgres',
          '-d',
          'horizon_phase43_restored_test',
          backupPath,
        ],
        { env: { PGPASSWORD: 'test' } },
      )
      if (restore.exitCode !== 0) throw new Error(`Phase 43 pg_restore failed: ${restore.stderr}`)
    } finally {
      await restoredAdmin.end()
    }
    const restoredUrl = restoredContainer
      .getConnectionUri()
      .replace('postgres:test@', 'horizon_app:test@')
    const restoredArtifacts = new FiscalArtifacts(
      restoredUrl,
      new EncryptedFiscalArtifactStore(new LocalObjectStore(restoredObjects), artifactKey),
    )
    const restoredObservations = new HomologationObservations(restoredUrl)
    const restoredLedger = new HomologationExchangeLedger(restoredUrl, restoredArtifacts)
    const restoredVerifier = new HomologationRestoreVerifier(
      restoredUrl,
      restoredArtifacts,
      restoredObservations,
    )
    try {
      const source = new HomologationRestoreVerifier(
        appUrl,
        input.sourceArtifacts,
        input.sourceObservations,
      )
      let sourceDigests: string[]
      try {
        sourceDigests = (await source.verify(input.tenantId, input.documentId)).digests
      } finally {
        await source.close()
      }
      expect((await restoredVerifier.verify(input.tenantId, input.documentId)).digests).toEqual(
        sourceDigests,
      )
      await expect(restoredVerifier.verify(randomUUID(), input.documentId)).rejects.toThrow(
        'Homologation restore document is unavailable',
      )
      expect(await restoredLedger.nextPreparedForActive(input.tenantId)).toBeNull()
      let sends = 0
      const runner = new HomologationExchangeRunner(
        restoredLedger,
        {
          endpointSetDigest: input.endpointDigest,
          certificateFingerprint: input.certificateFingerprint,
          async send() {
            sends += 1
            throw new Error('Restored pending exchange must not be resent')
          },
        },
        input.adapter,
        input.responseSchemas,
      )
      await expect(
        runner.resume(
          {
            tenantId: input.tenantId,
            exchangeId: input.pendingStatusId,
            actorId: 'tester:restore',
            workerId: 'worker-restored',
          },
          input.operations,
        ),
      ).rejects.toBeInstanceOf(UncertainSefazOutcomeError)
      expect(sends).toBe(0)
      expect(
        (
          await new HomologationRawRecovery(
            restoredLedger,
            input.adapter,
            input.responseSchemas,
          ).reparse(input.tenantId, input.rawOnlyStatusId, 'tester:restore', input.operations)
        ).statusCode,
      ).toBe('107')
      expect(
        (
          await restoredLedger.loadPrepared(
            input.tenantId,
            input.rawOnlyStatusId,
            input.operations,
            'tester:restore',
          )
        ).stage,
      ).toBe('observed')
    } finally {
      await Promise.all([
        restoredVerifier.close(),
        restoredLedger.close(),
        restoredObservations.close(),
        restoredArtifacts.close(),
      ])
    }
  } finally {
    await Promise.allSettled([
      restoredContainer?.stop(),
      rm(restoredDirectory, { recursive: true, force: true }),
    ])
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
  const firstOrigin = origin(tenantId, randomUUID())
  await ingress.accept(firstOrigin)
  await ingress.accept(origin(tenantId, randomUUID()))
  await ingress.accept(origin(otherTenant, randomUUID()))
  const intents = await administrator`select id, tenant_id, origin_id from fiscal_intents
    where tenant_id in (${tenantId}, ${otherTenant}) order by created_at, id`
  const own = intents.filter((row) => row.tenant_id === tenantId)
  const firstIntent = own.find((row) => row.origin_id === firstOrigin.payload.originId)
  const secondIntent = own.find((row) => row.origin_id !== firstOrigin.payload.originId)
  const foreign = intents.find((row) => row.tenant_id === otherTenant)
  if (!firstIntent || !secondIntent || !foreign) throw new Error('Test intents were not stored')
  const establishmentId = randomUUID()
  const input = {
    tenantId,
    intentId: String(firstIntent.id),
    model: '55' as const,
    environment: 'simulation' as const,
    establishmentId,
    series: 1,
  }
  const [first, duplicate] = await Promise.all([
    documents.createDraft(input),
    documents.createDraft(input),
  ])
  expect(duplicate.id).toBe(first.id)
  expect(await documents.readSnapshot(tenantId, first.id)).toEqual(firstOrigin.payload)
  const [capturedOrigin] = await administrator`select payload_ciphertext
    from fiscal_origin_payloads where tenant_id = ${tenantId} and intent_id = ${firstIntent.id}`
  expect(Buffer.from(capturedOrigin?.payload_ciphertext).includes(Buffer.from('Item'))).toBe(false)
  const [storedSnapshot] = await administrator`select snapshot_ciphertext
    from fiscal_documents where tenant_id = ${tenantId} and id = ${first.id}`
  expect(Buffer.from(storedSnapshot?.snapshot_ciphertext).includes(Buffer.from('1000'))).toBe(false)
  await expect(documents.createDraft({ ...input, model: '65' })).rejects.toThrow(
    'Conflicting fiscal draft',
  )
  await expect(documents.createDraft({ ...input, intentId: String(foreign.id) })).rejects.toThrow()
  const second = await documents.createDraft({
    ...input,
    intentId: String(secondIntent.id),
    idempotencyKey: randomUUID(),
  })
  const [secondKey] = await administrator`select key from fiscal_idempotency
    where tenant_id = ${tenantId} and document_id = ${second.id}`
  expect(
    (
      await documents.createDraft({
        ...input,
        intentId: String(secondIntent.id),
        idempotencyKey: String(secondKey?.key),
      })
    ).id,
  ).toBe(second.id)
  await expect(
    documents.createDraft({
      ...input,
      idempotencyKey: String(secondKey?.key),
    }),
  ).rejects.toThrow('Conflicting fiscal idempotency key')
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
  const auditRows = await administrator`select * from fiscal_audit_entries
    where tenant_id = ${tenantId} order by sequence`
  const [auditHead] = await administrator`select sequence, hash from fiscal_audit_heads
    where tenant_id = ${tenantId}`
  expect(
    verifyAuditRows(
      auditRows as unknown as AuditRow[],
      auditHead as { sequence: number; hash: string },
    ),
  ).toBe(true)
  const altered = auditRows.map((row) => ({ ...row })) as AuditRow[]
  if (!altered[0]) throw new Error('Audit chain was not recorded')
  altered[0].action = 'document.changed'
  expect(verifyAuditRows(altered, auditHead as { sequence: number; hash: string })).toBe(false)
})

it('does not resubmit after a crash before the simulator call', async () => {
  const tenantId = randomUUID()
  await ingress.accept(origin(tenantId, randomUUID()))
  const [intent] = await administrator`select id from fiscal_intents where tenant_id = ${tenantId}`
  if (!intent) throw new Error('Test intent was not stored')
  const draft = await documents.createDraft({
    tenantId,
    intentId: String(intent.id),
    model: '55',
    environment: 'simulation',
    establishmentId: randomUUID(),
    series: 1,
  })
  const gateway = new DeterministicAuthorityGateway('authorized')
  const first = new FiscalLifecycle(appUrl, gateway)
  try {
    await bindIllustrativeCalculation(tenantId, draft.id)
    await first.validate(tenantId, draft.id)
    await documents.reserveNumber(tenantId, draft.id)
    await first.prepareSubmission(tenantId, draft.id)
  } finally {
    await first.close()
  }
  const restarted = new FiscalLifecycle(appUrl, gateway)
  try {
    expect((await restarted.submit(tenantId, draft.id)).outcome).toBe('unknown')
    const [attempts] = await administrator`select count(*)::integer as value
      from authority_attempts where tenant_id = ${tenantId} and document_id = ${draft.id}`
    const [numbers] = await administrator`select count(*)::integer as value
      from fiscal_number_reservations where tenant_id = ${tenantId} and document_id = ${draft.id}`
    expect([attempts?.value, numbers?.value]).toEqual([1, 1])
    expect((await documents.get(tenantId, draft.id))?.status).toBe('unknown')
  } finally {
    await restarted.close()
  }
})

it('retains encrypted artifacts after restart and denies another tenant', async () => {
  const tenantId = randomUUID()
  const otherTenant = randomUUID()
  await ingress.accept(origin(tenantId, randomUUID()))
  const [intent] = await administrator`select id from fiscal_intents where tenant_id = ${tenantId}`
  if (!intent) throw new Error('Test intent was not stored')
  const draft = await documents.createDraft({
    tenantId,
    intentId: String(intent.id),
    model: '55',
    environment: 'simulation',
    establishmentId: randomUUID(),
    series: 1,
  })
  const store = new EncryptedFiscalArtifactStore(new LocalObjectStore(artifactRoot), artifactKey)
  const artifacts = new FiscalArtifacts(appUrl, store)
  const bytes = Buffer.from('<NFe>simulated-only</NFe>')
  const input = {
    tenantId,
    documentId: draft.id,
    kind: 'xml' as const,
    mediaType: 'application/xml',
    sourceSchema: 'test-schema-v1',
  }
  try {
    const first = await artifacts.put(input, bytes)
    expect((await artifacts.put(input, bytes)).digest).toBe(first.digest)
    const signed = await artifacts.put({ ...input, kind: 'signed_xml' }, bytes)
    expect(await artifacts.list(tenantId, draft.id)).toMatchObject({
      documentId: draft.id,
      artifacts: [{ kind: 'signed_xml', digest: signed.digest, simulated: true }],
    })
    expect(await artifacts.list(otherTenant, draft.id)).toBeNull()
    const key = `${tenantId}/${draft.id}/xml/${first.digest}`
    const path = join(artifactRoot, key)
    expect((await readFile(path)).includes(bytes)).toBe(false)
    await artifacts.close()
    const restarted = new FiscalArtifacts(
      appUrl,
      new EncryptedFiscalArtifactStore(new LocalObjectStore(artifactRoot), artifactKey),
    )
    try {
      expect((await restarted.get(tenantId, draft.id, 'xml', first.digest)).bytes).toEqual(bytes)
      await expect(restarted.get(otherTenant, draft.id, 'xml', first.digest)).rejects.toThrow(
        'not found',
      )
      await expect(restarted.put({ ...input, tenantId: otherTenant }, bytes)).rejects.toThrow(
        'not found',
      )
      const packed = await readFile(path)
      packed[packed.length - 1] = (packed.at(-1) ?? 0) ^ 1
      await writeFile(path, packed)
      await expect(restarted.get(tenantId, draft.id, 'xml', first.digest)).rejects.toThrow()
    } finally {
      await restarted.close()
    }
  } finally {
    await artifacts.close()
  }
})

it('reconciles an uncertain simulation after restart without allocating another number', async () => {
  const tenantId = randomUUID()
  const otherTenant = randomUUID()
  await ingress.accept(origin(tenantId, randomUUID()))
  const [intent] = await administrator`select id from fiscal_intents where tenant_id = ${tenantId}`
  if (!intent) throw new Error('Test intent was not stored')
  const draft = await documents.createDraft({
    tenantId,
    intentId: String(intent.id),
    model: '55',
    environment: 'simulation',
    establishmentId: randomUUID(),
    series: 1,
  })
  const gateway = new DeterministicAuthorityGateway('authorized', true)
  const firstProcess = new FiscalLifecycle(appUrl, gateway)
  try {
    await expect(firstProcess.validate(otherTenant, draft.id)).rejects.toThrow('not found')
    await bindIllustrativeCalculation(tenantId, draft.id)
    await firstProcess.validate(tenantId, draft.id)
    await firstProcess.validate(tenantId, draft.id)
    expect(await documents.reserveNumber(tenantId, draft.id)).toBe(1)
    expect((await firstProcess.submit(tenantId, draft.id)).outcome).toBe('unknown')
  } finally {
    await firstProcess.close()
  }
  const restarted = new FiscalLifecycle(appUrl, gateway)
  try {
    expect((await restarted.reconcile(tenantId, draft.id)).outcome).toBe('authorized')
    expect((await restarted.submit(tenantId, draft.id)).outcome).toBe('authorized')
    const [attempts] = await administrator`select count(*)::integer as value
      from authority_attempts where tenant_id = ${tenantId} and document_id = ${draft.id}`
    const [numbers] = await administrator`select count(*)::integer as value
      from fiscal_number_reservations where tenant_id = ${tenantId} and document_id = ${draft.id}`
    const [lines] = await administrator`select count(*)::integer as value
      from fiscal_document_lines where tenant_id = ${tenantId} and document_id = ${draft.id}`
    expect([attempts?.value, numbers?.value, lines?.value]).toEqual([1, 1, 1])
    expect((await documents.get(tenantId, draft.id))?.status).toBe('authorized')
    expect(
      (await restarted.requestCancellation(tenantId, draft.id, 'Requested in simulation')).outcome,
    ).toBe('unknown')
  } finally {
    await restarted.close()
  }
  const cancellationRecovery = new FiscalLifecycle(appUrl, gateway)
  try {
    expect((await cancellationRecovery.reconcileCancellation(tenantId, draft.id)).outcome).toBe(
      'cancelled',
    )
    expect((await documents.get(tenantId, draft.id))?.status).toBe('cancelled')
    const [cancellations] = await administrator`select count(*)::integer as value
      from cancellation_attempts where tenant_id = ${tenantId} and document_id = ${draft.id}`
    expect(cancellations?.value).toBe(1)
  } finally {
    await cancellationRecovery.close()
  }
})

it('creates one immutable successor revision from a rejected document', async () => {
  const tenantId = randomUUID()
  const original = origin(tenantId, randomUUID())
  const corrected = origin(tenantId, randomUUID())
  const competing = origin(tenantId, randomUUID())
  await ingress.accept(original)
  await ingress.accept(corrected)
  await ingress.accept(competing)
  const intents = await administrator`select id, origin_id from fiscal_intents
    where tenant_id = ${tenantId}`
  const originalIntent = intents.find((row) => row.origin_id === original.payload.originId)
  const correctedIntent = intents.find((row) => row.origin_id === corrected.payload.originId)
  const competingIntent = intents.find((row) => row.origin_id === competing.payload.originId)
  if (!originalIntent || !correctedIntent || !competingIntent)
    throw new Error('Correction test origins were not stored')
  const predecessor = await documents.createDraft({
    tenantId,
    intentId: String(originalIntent.id),
    model: '55',
    environment: 'simulation',
    establishmentId: randomUUID(),
    series: 1,
  })
  await bindIllustrativeCalculation(tenantId, predecessor.id)
  await documents.reserveNumber(tenantId, predecessor.id)
  const lifecycle = new FiscalLifecycle(appUrl, new DeterministicAuthorityGateway('rejected'))
  try {
    expect((await lifecycle.submit(tenantId, predecessor.id)).outcome).toBe('rejected')
  } finally {
    await lifecycle.close()
  }
  const request = {
    tenantId,
    documentId: predecessor.id,
    correctedIntentId: String(correctedIntent.id),
    idempotencyKey: randomUUID(),
    actorId: 'issuer:test',
    reason: 'Correct the owner-approved commercial origin',
  }
  const successor = await documents.createSuccessor(request)
  expect(successor).toMatchObject({
    status: 'draft',
    rootDocumentId: predecessor.id,
    predecessorDocumentId: predecessor.id,
    revision: 2,
    existing: false,
  })
  expect(await documents.readSnapshot(tenantId, successor.id)).toEqual(corrected.payload)
  expect(await documents.createSuccessor(request)).toEqual({ ...successor, existing: true })
  await expect(
    documents.createSuccessor({
      ...request,
      idempotencyKey: randomUUID(),
      correctedIntentId: String(competingIntent.id),
    }),
  ).rejects.toThrow('different successor')
  const [evidence] = await administrator`select
      (select count(*)::integer from fiscal_documents
        where tenant_id = ${tenantId} and root_document_id = ${predecessor.id}) as revisions,
      (select count(*)::integer from fiscal_number_reservations
        where tenant_id = ${tenantId} and document_id = ${successor.id}) as successor_numbers`
  expect(evidence).toMatchObject({ revisions: 2, successor_numbers: 0 })
})

async function bindIllustrativeCalculation(tenantId: string, documentId: string): Promise<void> {
  const calculationId = randomUUID()
  await administrator.begin(async (tx) => {
    await tx`insert into fiscal_calculations (
      id, tenant_id, document_id, input_ciphertext, input_digest, resolved_rules,
      rules_digest, result_bytes, result_digest, explanation_template_version,
      explanation_text, rule_version_ids, package_digests, supported, actor_id
    ) values (
      ${calculationId}, ${tenantId}, ${documentId}, ${Buffer.from('test-encrypted-input')},
      ${'a'.repeat(64)}, ${tx.json({ fixture: true })}, ${'b'.repeat(64)},
      ${Buffer.from('{"fixture":true}')}, ${'c'.repeat(64)}, 'test-v1',
      'Illustrative lifecycle fixture', ${[]}, ${[]}, true, 'test:fixture'
    )`
    await tx`insert into fiscal_document_calculation_bindings (
      tenant_id, document_id, calculation_id
    ) values (${tenantId}, ${documentId}, ${calculationId})`
    await tx`update fiscal_documents set status = 'ready'
      where tenant_id = ${tenantId} and id = ${documentId}`
  })
}

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
    async catalogItem(requestedId) {
      return { id: requestedId, kind: 'product', name: 'Café torrado', active: true }
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
