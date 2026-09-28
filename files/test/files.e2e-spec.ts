import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Channel, type ChannelModel, connect } from 'amqplib'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Attachments } from '@/application/attachments'
import { AttachmentLifecycle } from '@/application/lifecycle'
import { AesGcmEnvelope } from '@/infrastructure/cryptography/envelope'
import { FilesDatabase, RelayDueScan } from '@/infrastructure/database/drizzle/files-database'
import { erasureHandlers } from '@/infrastructure/messaging/erasure-handlers'
import {
  OutboxRelay,
  RabbitMqEventConsumer,
  RabbitMqEventPublisher,
} from '@/infrastructure/messaging/rabbitmq-transport'
import { EICAR, EicarScanner } from '@/infrastructure/scanning/scanners'
import { FileObjectStore } from '@/infrastructure/storage/object-stores'

/**
 * Attachments end to end against real PostgreSQL, RabbitMQ and a directory store (Phase 65):
 * sealed at rest, quarantined, shredded with their owner, invisible across tenants, and
 * found by the worker as the relay role, which reads nothing else.
 */
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
let now = new Date()
const clock = { now: () => now }
let database: FilesDatabase
let administrator: ReturnType<typeof postgres>
let relay: ReturnType<typeof postgres>
let root: string
let store: FileObjectStore
let envelope: AesGcmEnvelope
let attachments: Attachments
let lifecycle: AttachmentLifecycle
let scan: RelayDueScan

const relayUrl = () =>
  (process.env.DATABASE_URL ?? '').replace(/\/\/[^:]+:[^@]+@/, '//horizon_relay:test@')

beforeAll(async () => {
  database = new FilesDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
  relay = postgres(relayUrl(), { max: 1 })
  root = await mkdtemp(join(tmpdir(), 'horizon-attachments-'))
  store = new FileObjectStore(root)
  envelope = new AesGcmEnvelope(randomBytes(32))
  attachments = new Attachments(database, store, new EicarScanner(), envelope, clock, {
    scanRetryMs: 30_000,
  })
  lifecycle = new AttachmentLifecycle(database, attachments, store, clock, {
    batch: 10,
    claimMs: 120_000,
    scanRetryMs: 30_000,
  })
  scan = new RelayDueScan(relayUrl())
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end(), relay?.end(), scan?.close()])
})

async function upload(tenantId: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const requested = await attachments.request(
    { tenantId, actor: randomUUID(), requestId: null, idempotencyKey: randomUUID() },
    {
      module: 'parties',
      recordType: 'party',
      recordId: randomUUID(),
      fileName: 'contrato social.pdf',
      contentType: 'application/pdf',
      size: bytes.length,
      ...overrides,
    } as Parameters<Attachments['request']>[1],
  )
  if (requested.isLeft()) throw requested.value
  const received = await attachments.receive(tenantId, requested.value.id, {
    contentType: requested.value.contentType,
    bytes,
  })
  if (received.isLeft()) throw received.value
  return received.value
}

describe('an attachment at rest', () => {
  it('is served decrypted, and stored only as ciphertext', async () => {
    const tenantId = randomUUID()
    const attachment = await upload(tenantId, PDF)
    expect(attachment.status).toBe('available')
    const object = await store.get(attachment.objectKey ?? '')
    expect(object.includes(Buffer.from('/Catalog'))).toBe(false)
    expect((await attachments.content(tenantId, attachment.id))?.bytes).toEqual(PDF)
    const [row] = await administrator`
      select status, sha256, available_at from attachments where id = ${attachment.id}`
    expect(row?.status).toBe('available')
    const events = await administrator`
      select event_type, payload from outbox where tenant_id = ${tenantId}`
    expect(events.map((event) => event.event_type)).toEqual(['files.attachment.available'])
    expect(JSON.stringify(events[0]?.payload)).not.toContain('contrato')
  })

  it('keeps an audit chain of who asked for it', async () => {
    const tenantId = randomUUID()
    const attachment = await upload(tenantId, PDF)
    await attachments.issueLink({ tenantId, actor: randomUUID(), requestId: 'r' }, attachment.id)
    const chain = await administrator`
      select sequence, action, previous_hash, hash from audit_log
        where tenant_id = ${tenantId} order by sequence`
    expect(chain.map((entry) => entry.action)).toEqual([
      'attachment.requested',
      'attachment.link-issued',
    ])
    expect(chain[1]?.previous_hash).toBe(chain[0]?.hash)
  })
})

describe('the EICAR test file', () => {
  it('is quarantined, its bytes removed and logged, and never served', async () => {
    const tenantId = randomUUID()
    const attachment = await upload(tenantId, Buffer.from(EICAR), {
      fileName: 'eicar.txt',
      contentType: 'text/plain',
    })
    expect(attachment.status).toBe('quarantined')
    expect(await attachments.content(tenantId, attachment.id)).toBeNull()
    expect(await readdir(join(root, 'attachments', tenantId)).catch(() => [])).toEqual([])
    const removals = await administrator`
      select reason, bytes from attachment_removals where attachment_id = ${attachment.id}`
    expect(removals).toMatchObject([{ reason: 'quarantined', bytes: EICAR.length }])
    await expect(
      administrator`delete from attachment_removals where attachment_id = ${attachment.id}`,
    ).rejects.toThrow(/append-only/)
  })
})

describe('erasure', () => {
  it('destroys the party key, so its attachment can no longer be decrypted', async () => {
    const tenantId = randomUUID()
    const partyId = randomUUID()
    const attachment = await upload(tenantId, PDF, { recordId: partyId })
    const object = await store.get(attachment.objectKey ?? '')
    const erased = await lifecycle.eraseOwner(
      {
        tenantId,
        sourceModule: 'parties',
        eventId: randomUUID(),
        eventType: 'parties.party.erased',
      },
      { type: 'party', id: partyId },
    )
    expect(erased).toBe(true)
    const [key] = await administrator`
      select wrapped_key, erased_at from owner_keys
        where tenant_id = ${tenantId} and owner_type = 'party' and owner_id = ${partyId}`
    expect(key?.wrapped_key).toBeNull()
    const [row] = await administrator`
      select status, deletion_reason, wrapped_data_key from attachments where id = ${attachment.id}`
    expect(row).toMatchObject({ status: 'deleted', deletion_reason: 'erased' })
    // Every key left in the database, tried against the bytes: none opens them.
    const keys = await administrator`
      select wrapped_key from owner_keys where tenant_id = ${tenantId} and wrapped_key is not null`
    for (const candidate of keys)
      expect(() =>
        envelope.open(
          String(candidate.wrapped_key),
          { tenantId, attachmentId: attachment.id, owner: { type: 'party', id: partyId } },
          String(row?.wrapped_data_key),
          object,
        ),
      ).toThrow()
    expect(await attachments.content(tenantId, attachment.id)).toBeNull()
    await expect(
      administrator`update owner_keys set wrapped_key = 'x', erased_at = null
        where tenant_id = ${tenantId} and owner_id = ${partyId}`,
    ).rejects.toThrow(/cannot be restored/)
    await lifecycle.runTenant(tenantId)
    await expect(store.get(attachment.objectKey ?? '')).rejects.toThrow()
  })

  it('arrives as an event, once however often it is delivered', async () => {
    const tenantId = randomUUID()
    const partyId = randomUUID()
    const attachment = await upload(tenantId, PDF, { recordId: partyId })
    const consumer = new RabbitMqEventConsumer({
      url: process.env.RABBITMQ_URL ?? '',
      queue: `files.erasures.${randomUUID()}`,
      handlers: erasureHandlers(lifecycle),
    })
    await consumer.start()
    const publisher = await RabbitMqEventPublisher.open(process.env.RABBITMQ_URL ?? '')
    const event = {
      eventId: randomUUID(),
      eventType: 'parties.party.erased',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      tenantId,
      traceId: 'a'.repeat(32),
      payload: { partyId },
    }
    try {
      await publisher.publish(event)
      await publisher.publish(event)
      await waitFor(
        async () => (await attachments.find(tenantId, attachment.id))?.status === 'deleted',
      )
      const inbox =
        await administrator`select count(*)::int as n from inbox where event_id = ${event.eventId}`
      expect(inbox[0]?.n).toBe(1)
      const ended = await administrator`
        select count(*)::int as n from outbox
          where tenant_id = ${tenantId} and event_type = 'files.attachment.deleted'`
      expect(ended[0]?.n).toBe(1)
    } finally {
      await consumer.close()
      await publisher.close()
    }
  })
})

describe('tenancy and the relay role', () => {
  it('shows another tenant nothing', async () => {
    const tenantId = randomUUID()
    const attachment = await upload(tenantId, PDF)
    const stranger = randomUUID()
    expect(await attachments.find(stranger, attachment.id)).toBeNull()
    expect(await attachments.list(stranger, attachment)).toEqual([])
    expect(await attachments.content(stranger, attachment.id)).toBeNull()
  })

  it('lets the relay find tenants with due rows, and read nothing else', async () => {
    const tenantId = randomUUID()
    await attachments.request(
      { tenantId, actor: randomUUID(), requestId: null, idempotencyKey: randomUUID() },
      {
        module: 'crm',
        recordType: 'opportunity',
        recordId: randomUUID(),
        fileName: 'proposta.pdf',
        contentType: 'application/pdf',
        size: 10,
      },
    )
    now = new Date(Date.now() + 2 * 3_600_000)
    expect(await scan.tenantsWithWork(now)).toContain(tenantId)
    await expect(relay`select file_name from attachments limit 1`).rejects.toThrow(/permission/)
    await expect(relay`select * from owner_keys limit 1`).rejects.toThrow(/permission/)
    const outcome = await lifecycle.runTenant(tenantId)
    expect(outcome.abandoned).toBe(1)
    expect(await scan.tenantsWithWork(now)).not.toContain(tenantId)
    now = new Date()
  })
})

describe('the outbox', () => {
  it('publishes what happened to an attachment, without its name', async () => {
    const tenantId = randomUUID()
    await upload(tenantId, PDF, { fileName: 'atestado-joao.pdf' })
    const connection: ChannelModel = await connect(process.env.RABBITMQ_URL ?? '')
    const channel: Channel = await connection.createChannel()
    const queue = `files.test.${randomUUID()}`
    await channel.assertExchange('horizon.events', 'topic', { durable: true })
    await channel.assertQueue(queue, { exclusive: true })
    await channel.bindQueue(queue, 'horizon.events', 'files.attachment.*')
    const publisher = await RabbitMqEventPublisher.open(process.env.RABBITMQ_URL ?? '')
    const outbox = new OutboxRelay(relayUrl(), publisher)
    try {
      await waitFor(async () => (await outbox.flush()) === 0, 5)
      const message = await waitFor(async () => (await channel.get(queue, { noAck: true })) || null)
      const body = message ? message.content.toString() : ''
      expect(body).toContain('files.attachment.available')
      expect(body).not.toContain('atestado')
    } finally {
      await outbox.close()
      await publisher.close()
      await connection.close()
    }
  })
})

async function waitFor<T>(probe: () => Promise<T>, attempts = 50): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting')
}
