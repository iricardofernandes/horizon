import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { InboundInvoice } from './nfe55/inbound'

function keyFor(master: Buffer, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(tenantId), 'fiscal-inbound-snapshot-v1', 32),
  )
}

/** Seals the parsed invoice: it can name a person, so it never rests in plain text. */
export function sealInboundSnapshot(
  master: Buffer,
  tenantId: string,
  importId: string,
  invoice: InboundInvoice,
): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(master, tenantId), nonce)
  cipher.setAAD(Buffer.from(`${tenantId}:${importId}`))
  return Buffer.concat([
    Buffer.from([1]),
    nonce,
    cipher.update(JSON.stringify(invoice), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

export function openInboundSnapshot(
  master: Buffer,
  tenantId: string,
  importId: string,
  packed: Buffer,
): InboundInvoice {
  if (packed.length < 29 || packed[0] !== 1) throw new Error('Invalid inbound snapshot envelope')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(master, tenantId), packed.subarray(1, 13))
  decipher.setAAD(Buffer.from(`${tenantId}:${importId}`))
  decipher.setAuthTag(packed.subarray(-16))
  const plaintext = Buffer.concat([decipher.update(packed.subarray(13, -16)), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as InboundInvoice
}
