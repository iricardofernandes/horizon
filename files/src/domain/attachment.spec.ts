import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type Attachment,
  acceptsBytes,
  deleted,
  dueWorkOf,
  purged,
  quarantined,
  released,
  scanFailed,
  slotOf,
  stored,
  TransitionRefused,
  UPLOAD_WINDOW_MS,
} from './attachment'

const now = new Date('2026-09-28T12:00:00.000Z')

function slot(): Attachment {
  return slotOf({
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
}

const storedSlot = () =>
  stored(slot(), {
    sha256: 'a'.repeat(64),
    wrappedDataKey: 'k',
    objectKey: 'o',
    now,
    retryMs: 1000,
  })

describe('the attachment lifecycle', () => {
  it('takes bytes only while uploading and inside the window', () => {
    const attachment = slot()
    expect(acceptsBytes(attachment, now)).toBe(true)
    expect(acceptsBytes(attachment, new Date(now.getTime() + UPLOAD_WINDOW_MS))).toBe(false)
    expect(acceptsBytes(storedSlot(), now)).toBe(false)
    expect(dueWorkOf(attachment)).toBe('abandon')
  })

  it('moves from scanning to available or quarantined, and nowhere else', () => {
    const scanning = storedSlot()
    expect(dueWorkOf(scanning)).toBe('scan')
    expect(scanFailed(scanning, now, 5).scanAttempts).toBe(1)
    const available = released(scanning, now)
    expect(available.expiresAt).not.toBeNull()
    expect(dueWorkOf(available)).toBe('expire')
    expect(() => released(available, now)).toThrow(TransitionRefused)
    expect(() =>
      stored(available, { sha256: '', wrappedDataKey: '', objectKey: '', now, retryMs: 1 }),
    ).toThrow(TransitionRefused)
    const found = quarantined(scanning, 'x'.repeat(300), now)
    expect(found.finding).toHaveLength(200)
    expect(dueWorkOf(found)).toBe('purge')
    expect(dueWorkOf(purged(found))).toBe('end-quarantine')
    expect(purged(found).dueAt).toEqual(found.expiresAt)
    expect(() => scanFailed(available, now, 1)).toThrow(TransitionRefused)
  })

  it('ends once, and is due now while it still has bytes', () => {
    const ended = deleted(storedSlot(), 'removed', now)
    expect(ended.dueAt).toEqual(now)
    expect(dueWorkOf(ended)).toBe('purge')
    expect(dueWorkOf(purged(ended))).toBe('none')
    expect(purged(ended).dueAt).toBeNull()
    expect(deleted(slot(), 'abandoned', now).dueAt).toBeNull()
    expect(() => deleted(ended, 'removed', now)).toThrow(TransitionRefused)
  })
})
