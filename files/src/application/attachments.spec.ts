import { randomUUID } from 'node:crypto'
import type { AttachmentRequest } from '@horizon/contracts'
import {
  FakeEnvelope,
  InMemoryFilesStore,
  InMemoryObjectStore,
  ManualClock,
  ScriptedScanner,
} from 'test/support/in-memory-files'
import { beforeEach, describe, expect, it } from 'vitest'
import { UPLOAD_WINDOW_MS } from '@/domain/attachment'
import { DAY_MS } from '@/domain/records'
import { Attachments, ownerOf } from './attachments'
import { AttachmentLifecycle } from './lifecycle'

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
const tenantId = randomUUID()
const actor = randomUUID()
const RETRY = 30_000

let store: InMemoryFilesStore
let objects: InMemoryObjectStore
let scanner: ScriptedScanner
let clock: ManualClock
let attachments: Attachments
let lifecycle: AttachmentLifecycle

beforeEach(() => {
  store = new InMemoryFilesStore()
  objects = new InMemoryObjectStore()
  scanner = new ScriptedScanner()
  clock = new ManualClock()
  attachments = new Attachments(store, objects, scanner, new FakeEnvelope(), clock, {
    scanRetryMs: RETRY,
  })
  lifecycle = new AttachmentLifecycle(store, attachments, objects, clock, {
    batch: 2,
    claimMs: 120_000,
    scanRetryMs: RETRY,
  })
})

function requestOf(overrides: Partial<AttachmentRequest> = {}): AttachmentRequest {
  return {
    module: 'financial',
    recordType: 'payable',
    recordId: randomUUID(),
    fileName: 'boleto.pdf',
    contentType: 'application/pdf',
    size: PDF.length,
    ...overrides,
  }
}

const context = (key = randomUUID()) => ({
  tenantId,
  actor,
  requestId: null,
  idempotencyKey: key,
})

async function slot(overrides: Partial<AttachmentRequest> = {}) {
  const outcome = await attachments.request(context(), requestOf(overrides))
  if (outcome.isLeft()) throw outcome.value
  return outcome.value
}

async function uploaded(bytes = PDF, overrides: Partial<AttachmentRequest> = {}) {
  const created = await slot({ size: bytes.length, ...overrides })
  const outcome = await attachments.receive(tenantId, created.id, {
    contentType: created.contentType,
    bytes,
  })
  if (outcome.isLeft()) throw outcome.value
  return outcome.value
}

const events = () => store.state(tenantId).outbox.map((event) => event.eventType)

describe('asking for a slot', () => {
  it('keys the file to the party it is about, or its uploader', () => {
    const party = randomUUID()
    expect(
      ownerOf(requestOf({ module: 'parties', recordType: 'party', recordId: party }), actor),
    ).toEqual({ type: 'party', id: party })
    expect(ownerOf(requestOf({ ownerPartyId: party }), actor)).toEqual({ type: 'party', id: party })
    expect(ownerOf(requestOf(), actor)).toEqual({ type: 'user', id: actor })
  })

  it('answers the same slot for the same key and body, and refuses another body', async () => {
    const input = requestOf()
    const first = await attachments.request(context('same-key-1'), input)
    const again = await attachments.request(context('same-key-1'), input)
    const other = await attachments.request(context('same-key-1'), { ...input, size: 99 })
    expect(again.value).toEqual(first.value)
    expect(other.isLeft() && other.value.title).toBe('Conflict')
    expect(store.state(tenantId).audit).toHaveLength(1)
  })

  it('refuses a slot for an erased owner', async () => {
    const party = randomUUID()
    await lifecycle.eraseOwner(
      { tenantId, sourceModule: 'parties', eventId: randomUUID(), eventType: 'x' },
      { type: 'party', id: party },
    )
    const outcome = await attachments.request(
      context(),
      requestOf({ module: 'parties', recordType: 'party', recordId: party }),
    )
    expect(outcome.isLeft() && outcome.value.message).toMatch(/erased/)
  })
})

describe('receiving the bytes', () => {
  it('stores them sealed and releases a clean file with its retention', async () => {
    const attachment = await uploaded()
    expect(attachment.status).toBe('available')
    expect(attachment.expiresAt?.getTime()).toBe(clock.now().getTime() + 1826 * DAY_MS)
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/)
    const stored = objects.objects.get(attachment.objectKey ?? '')
    expect(stored?.equals(PDF)).toBe(false)
    expect(events()).toEqual(['files.attachment.available'])
    const content = await attachments.content(tenantId, attachment.id)
    expect(content?.bytes.equals(PDF)).toBe(true)
  })

  it('keeps one object when two uploads of a slot race, and the bytes it serves are its own (Phase 92)', async () => {
    const created = await slot()
    const send = () =>
      attachments.receive(tenantId, created.id, { contentType: created.contentType, bytes: PDF })
    const [first, second] = await Promise.all([send(), send()])
    expect(first.isRight() && second.isRight()).toBe(true)
    // The upload that lost removed what it wrote: one object is left, the recorded one.
    const kept = [...objects.objects.keys()]
    expect(kept).toHaveLength(1)
    const content = await attachments.content(tenantId, created.id)
    expect(content?.bytes.equals(PDF)).toBe(true)
  })

  it('refuses bytes that are not what was declared', async () => {
    const created = await slot()
    const wrongSize = await attachments.receive(tenantId, created.id, {
      contentType: 'application/pdf',
      bytes: Buffer.concat([PDF, Buffer.from('x')]),
    })
    const wrongType = await attachments.receive(tenantId, created.id, {
      contentType: 'text/plain',
      bytes: PDF,
    })
    const notPdf = await attachments.receive(tenantId, created.id, {
      contentType: 'application/pdf',
      bytes: Buffer.alloc(PDF.length, 0x41),
    })
    for (const outcome of [wrongSize, wrongType, notPdf])
      expect(outcome.isLeft() && outcome.value.title).toBe('Invalid input')
    expect(objects.objects.size).toBe(0)
  })

  it('refuses bytes after the slot expired, or twice', async () => {
    const created = await slot()
    clock.advance(UPLOAD_WINDOW_MS)
    const late = await attachments.receive(tenantId, created.id, {
      contentType: 'application/pdf',
      bytes: PDF,
    })
    expect(late.isLeft() && late.value.title).toBe('Conflict')
    const done = await uploaded()
    const twice = await attachments.receive(tenantId, done.id, {
      contentType: 'application/pdf',
      bytes: PDF,
    })
    expect(twice.isLeft() && twice.value.message).toMatch(/available/)
    const missing = await attachments.receive(tenantId, randomUUID(), {
      contentType: 'application/pdf',
      bytes: PDF,
    })
    expect(missing.isLeft() && missing.value.title).toBe('Resource not found')
  })

  it('quarantines what the scanner finds, removes its bytes and never serves it', async () => {
    scanner.answer = { clean: false, finding: 'Eicar-Test-Signature' }
    const attachment = await uploaded(Buffer.from('not really a virus'), {
      contentType: 'text/plain',
      fileName: 'eicar.txt',
    })
    expect(attachment.status).toBe('quarantined')
    expect(attachment.finding).toBe('Eicar-Test-Signature')
    expect(attachment.objectKey).toBeNull()
    expect(objects.objects.size).toBe(0)
    expect(store.state(tenantId).removals.map((removal) => removal.reason)).toEqual(['quarantined'])
    expect(await attachments.content(tenantId, attachment.id)).toBeNull()
    const link = await attachments.issueLink({ tenantId, actor, requestId: null }, attachment.id)
    expect(link.isLeft()).toBe(true)
    expect(events()).toEqual(['files.attachment.quarantined'])
  })

  it('leaves a file scanning when the scanner does not answer, until it does', async () => {
    scanner.answer = 'fail'
    const attachment = await uploaded()
    expect(attachment.status).toBe('scanning')
    expect(await attachments.content(tenantId, attachment.id)).toBeNull()
    clock.advance(RETRY)
    expect((await lifecycle.runTenant(tenantId)).failed).toBe(1)
    expect((await attachments.find(tenantId, attachment.id))?.scanAttempts).toBe(1)
    scanner.answer = { clean: true }
    clock.advance(RETRY)
    expect((await lifecycle.runTenant(tenantId)).scanned).toBe(1)
    expect((await attachments.find(tenantId, attachment.id))?.status).toBe('available')
  })
})

describe('links, lists and removal', () => {
  it('lists what is on a record and audits a download link', async () => {
    const attachment = await uploaded()
    const listed = await attachments.list(tenantId, attachment)
    expect(listed.map((row) => row.id)).toEqual([attachment.id])
    expect(await attachments.list(randomUUID(), attachment)).toEqual([])
    const link = await attachments.issueLink({ tenantId, actor, requestId: 'r' }, attachment.id)
    expect(link.isRight()).toBe(true)
    expect(store.state(tenantId).audit.map((entry) => entry.action)).toEqual([
      'attachment.requested',
      'attachment.link-issued',
    ])
  })

  it('removes a file with its bytes, logs it, and refuses removing it again', async () => {
    const attachment = await uploaded()
    const removed = await attachments.remove({ tenantId, actor, requestId: null }, attachment.id)
    expect(removed.isRight() && removed.value.status).toBe('deleted')
    expect(objects.objects.size).toBe(0)
    expect(store.state(tenantId).removals.map((removal) => removal.reason)).toEqual(['removed'])
    const again = await attachments.remove({ tenantId, actor, requestId: null }, attachment.id)
    expect(again.isLeft()).toBe(true)
    expect(events()).toEqual(['files.attachment.available', 'files.attachment.deleted'])
  })

  it('leaves bytes it could not remove to the worker', async () => {
    const attachment = await uploaded()
    objects.failRemoval = true
    await attachments.remove({ tenantId, actor, requestId: null }, attachment.id)
    expect(objects.objects.size).toBe(1)
    objects.failRemoval = false
    expect((await lifecycle.runTenant(tenantId)).purged).toBe(1)
    expect(objects.objects.size).toBe(0)
  })
})

describe('the lifecycle', () => {
  it('abandons a slot never used, removing any bytes left behind', async () => {
    const created = await slot()
    await objects.put(`attachments/${tenantId}/${created.id}`, Buffer.from('orphan'))
    clock.advance(UPLOAD_WINDOW_MS)
    expect((await lifecycle.runTenant(tenantId)).abandoned).toBe(1)
    const ended = await attachments.find(tenantId, created.id)
    expect(ended?.deletionReason).toBe('abandoned')
    expect(objects.objects.size).toBe(0)
  })

  it('expires a file at the end of its retention and logs the removal', async () => {
    const attachment = await uploaded(PDF, { module: 'crm', recordType: 'opportunity' })
    clock.advance(729 * DAY_MS)
    expect((await lifecycle.runTenant(tenantId)).expired).toBe(0)
    clock.advance(DAY_MS)
    expect((await lifecycle.runTenant(tenantId)).expired).toBe(1)
    expect((await attachments.find(tenantId, attachment.id))?.deletionReason).toBe('expired')
    expect(store.state(tenantId).removals).toMatchObject([
      { attachmentId: attachment.id, reason: 'expired', bytes: PDF.length },
    ])
  })

  it('keeps a party file until the party is erased', async () => {
    const party = randomUUID()
    const attachment = await uploaded(PDF, {
      module: 'parties',
      recordType: 'party',
      recordId: party,
    })
    expect(attachment.expiresAt).toBeNull()
    clock.advance(4000 * DAY_MS)
    await lifecycle.runTenant(tenantId)
    expect((await attachments.find(tenantId, attachment.id))?.status).toBe('available')
  })

  it('ends a quarantined row after thirty days', async () => {
    scanner.answer = { clean: false, finding: 'Found' }
    const attachment = await uploaded(Buffer.from('text'), { contentType: 'text/plain' })
    clock.advance(30 * DAY_MS)
    await lifecycle.runTenant(tenantId)
    const ended = await attachments.find(tenantId, attachment.id)
    expect(ended?.deletionReason).toBe('quarantined')
    expect(ended?.dueAt).toBeNull()
  })

  it('works through more due rows than one batch holds', async () => {
    for (let index = 0; index < 5; index += 1) await slot()
    clock.advance(UPLOAD_WINDOW_MS)
    expect((await lifecycle.runTenant(tenantId)).abandoned).toBe(5)
  })
})

describe('erasure', () => {
  it('shreds the owner key, ends its files once, and leaves the bytes unreadable', async () => {
    const party = randomUUID()
    const attachment = await uploaded(PDF, { ownerPartyId: party })
    const other = await uploaded()
    const event = {
      tenantId,
      sourceModule: 'parties' as const,
      eventId: randomUUID(),
      eventType: 'parties.party.erased',
    }
    expect(await lifecycle.eraseOwner(event, { type: 'party', id: party })).toBe(true)
    expect(await lifecycle.eraseOwner(event, { type: 'party', id: party })).toBe(false)
    expect((await attachments.find(tenantId, attachment.id))?.deletionReason).toBe('erased')
    expect((await attachments.find(tenantId, other.id))?.status).toBe('available')
    expect(await attachments.content(tenantId, attachment.id)).toBeNull()
    expect(store.state(tenantId).ownerKeys.get(`party:${party}`)?.wrappedKey).toBeNull()
    await lifecycle.runTenant(tenantId)
    expect(objects.objects.has(attachment.objectKey ?? '')).toBe(false)
    expect(store.state(tenantId).removals.map((removal) => removal.reason)).toEqual(['erased'])
  })
})
