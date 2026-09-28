import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import {
  ATTACHABLE_RECORDS,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_DELETION_REASONS,
  ATTACHMENT_STATES,
  attachmentSchema,
} from '@horizon/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { deleted, released, slotOf, stored } from '@/domain/attachment'
import * as vocabulary from '@/domain/vocabulary'
import { AesGcmEnvelope, masterKeyOf } from './cryptography/envelope'
import { AttachmentLinks, LINK_TTL_MS } from './http/links'
import { viewOf } from './http/views'
import { ClamdScanner, EICAR, EicarScanner, instreamOf, verdictOf } from './scanning/scanners'

const tenantId = randomUUID()
const context = {
  tenantId,
  attachmentId: randomUUID(),
  owner: { type: 'party' as const, id: randomUUID() },
}

describe('envelope encryption', () => {
  const envelope = new AesGcmEnvelope(randomBytes(32))
  const ownerKey = envelope.newOwnerKey(tenantId, context.owner)
  const plaintext = Buffer.from('%PDF-1.7 contrato assinado')

  it('opens what it sealed, and never stores the plaintext', () => {
    const sealed = envelope.seal(ownerKey, context, plaintext)
    expect(sealed.object.includes(plaintext)).toBe(false)
    expect(envelope.open(ownerKey, context, sealed.wrappedDataKey, sealed.object)).toEqual(
      plaintext,
    )
  })

  it('opens nothing under another owner, attachment, tenant or master key', () => {
    const sealed = envelope.seal(ownerKey, context, plaintext)
    const open = (key: string, other = context, box = envelope) =>
      box.open(key, other, sealed.wrappedDataKey, sealed.object)
    expect(() => open(envelope.newOwnerKey(tenantId, context.owner))).toThrow()
    expect(() => open(ownerKey, { ...context, attachmentId: randomUUID() })).toThrow()
    expect(() => open(ownerKey, { ...context, tenantId: randomUUID() })).toThrow()
    expect(() =>
      open(ownerKey, { ...context, owner: { type: 'user', id: context.owner.id } }),
    ).toThrow()
    expect(() => open(ownerKey, context, new AesGcmEnvelope(randomBytes(32)))).toThrow()
  })

  it('refuses tampered bytes and an unknown version', () => {
    const sealed = envelope.seal(ownerKey, context, plaintext)
    const tampered = Buffer.from(sealed.object)
    tampered[20] = (tampered[20] ?? 0) ^ 1
    expect(() => envelope.open(ownerKey, context, sealed.wrappedDataKey, tampered)).toThrow()
    const versioned = Buffer.from(sealed.object)
    versioned[0] = 9
    expect(() => envelope.open(ownerKey, context, sealed.wrappedDataKey, versioned)).toThrow()
  })

  it('reads the master key as hex or base64 of 32 bytes only', () => {
    expect(masterKeyOf('ab'.repeat(32))).toHaveLength(32)
    expect(masterKeyOf(randomBytes(32).toString('base64'))).toHaveLength(32)
    expect(() => masterKeyOf(randomBytes(16).toString('base64'))).toThrow()
    expect(() => new AesGcmEnvelope(randomBytes(16))).toThrow()
  })
})

describe('the EICAR scanner', () => {
  it('finds the test string anywhere, and nothing else', async () => {
    const scanner = new EicarScanner()
    expect(await scanner.scan(Buffer.from(EICAR))).toEqual({
      clean: false,
      finding: 'Eicar-Test-Signature',
    })
    expect(await scanner.scan(Buffer.from(`prefix ${EICAR}`))).toMatchObject({ clean: false })
    expect(await scanner.scan(Buffer.from('%PDF-1.7'))).toEqual({ clean: true })
  })
})

describe('the clamd protocol', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined))
    server = undefined
  })

  function clamd(reply: (received: Buffer) => string | null): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        const chunks: Buffer[] = []
        socket.on('data', (data) => chunks.push(data))
        socket.on('end', () => {
          const answer = reply(Buffer.concat(chunks))
          if (answer === null) socket.destroy()
          else socket.end(answer)
        })
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  it('frames the stream in length-prefixed chunks ending in zero', () => {
    const framed = instreamOf(Buffer.alloc(70_000, 1))
    expect(framed.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0')
    expect(framed.readUInt32BE(10)).toBe(65_536)
    expect(framed.readUInt32BE(10 + 4 + 65_536)).toBe(70_000 - 65_536)
    expect(framed.subarray(-4).readUInt32BE(0)).toBe(0)
  })

  it('reads the verdicts clamd answers, and refuses anything else', () => {
    expect(verdictOf('stream: OK\0')).toEqual({ clean: true })
    expect(verdictOf('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      clean: false,
      finding: 'Win.Test.EICAR_HDB-1',
    })
    expect(() => verdictOf('INSTREAM size limit exceeded. ERROR\0')).toThrow()
  })

  it('scans over TCP, and fails when the daemon hangs up or answers nonsense', async () => {
    const port = await clamd((received) =>
      received.includes(EICAR) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0',
    )
    const scanner = new ClamdScanner('127.0.0.1', port, 2000)
    expect(await scanner.scan(Buffer.from(EICAR))).toMatchObject({ clean: false })
    expect(await scanner.scan(Buffer.from('fine'))).toEqual({ clean: true })
    await new Promise((resolve) => server?.close(resolve))
    const silent = await clamd(() => null)
    await expect(
      new ClamdScanner('127.0.0.1', silent, 2000).scan(Buffer.from('x')),
    ).rejects.toThrow()
    await new Promise((resolve) => server?.close(resolve))
    const odd = await clamd(() => 'what?')
    await expect(new ClamdScanner('127.0.0.1', odd, 2000).scan(Buffer.from('x'))).rejects.toThrow()
    await expect(new ClamdScanner('127.0.0.1', 1, 2000).scan(Buffer.from('x'))).rejects.toThrow()
  })
})

describe('signed links', () => {
  const links = new AttachmentLinks('s'.repeat(40))
  const now = new Date('2026-09-28T12:00:00.000Z')
  const attachmentId = randomUUID()

  function queryOf(url: string) {
    const params = new URL(url, 'http://x').searchParams
    return {
      tenantId: params.get('tenant') ?? '',
      attachmentId,
      expires: Number(params.get('expires')),
      signature: params.get('signature') ?? '',
    }
  }

  it('opens one kind of access to one file of one tenant until it expires', () => {
    const upload = links.sign('upload', tenantId, attachmentId, now)
    expect(upload.method).toBe('PUT')
    expect(upload.url).toMatch(new RegExp(`^/files/uploads/${attachmentId}\\?`))
    const query = queryOf(upload.url)
    expect(links.verify('upload', query, now)).toBe(true)
    expect(links.verify('download', query, now)).toBe(false)
    expect(links.verify('upload', { ...query, attachmentId: randomUUID() }, now)).toBe(false)
    expect(links.verify('upload', { ...query, tenantId: randomUUID() }, now)).toBe(false)
    expect(links.verify('upload', query, new Date(now.getTime() + LINK_TTL_MS.upload + 1))).toBe(
      false,
    )
  })

  it('refuses a stretched expiry and a short secret', () => {
    const download = links.sign('download', tenantId, attachmentId, now)
    expect(download.url).toMatch(/\/content\?/)
    const query = queryOf(download.url)
    expect(links.verify('download', { ...query, expires: query.expires + 1 }, now)).toBe(false)
    expect(links.verify('download', { ...query, signature: 'ab' }, now)).toBe(false)
    expect(() => new AttachmentLinks('short')).toThrow()
  })
})

describe('the domain vocabulary and the published contract', () => {
  it('holds the same record types, states, reasons and content types', () => {
    expect(vocabulary.ATTACHABLE_RECORDS).toEqual(ATTACHABLE_RECORDS)
    expect(vocabulary.ATTACHMENT_STATES).toEqual(ATTACHMENT_STATES)
    expect(vocabulary.DELETION_REASONS).toEqual(ATTACHMENT_DELETION_REASONS)
    expect(vocabulary.CONTENT_TYPES).toEqual(ATTACHMENT_CONTENT_TYPES)
  })

  it('publishes an attachment the contract accepts, without owner, key or storage', () => {
    const now = new Date('2026-09-28T12:00:00.000Z')
    const slot = slotOf({
      id: randomUUID(),
      record: { module: 'sales', recordType: 'service-order', recordId: randomUUID() },
      fileName: 'laudo.pdf',
      contentType: 'application/pdf',
      size: 10,
      owner: { type: 'user', id: randomUUID() },
      idempotencyKey: 'key-12345',
      fingerprint: 'f'.repeat(64),
      uploadedBy: randomUUID(),
      now,
    })
    const available = released(
      stored(slot, {
        sha256: 'a'.repeat(64),
        wrappedDataKey: 'k',
        objectKey: 'o',
        now,
        retryMs: 1,
      }),
      now,
    )
    const view = viewOf(available)
    expect(attachmentSchema.safeParse(view).success).toBe(true)
    expect(Object.keys(view)).not.toContain('owner')
    expect(Object.keys(view)).not.toContain('objectKey')
    expect(view.expiresAt).not.toBeNull()
    expect(viewOf(deleted(available, 'removed', now)).expiresAt).toBeNull()
    expect(attachmentSchema.safeParse(viewOf(slot)).success).toBe(true)
  })
})
