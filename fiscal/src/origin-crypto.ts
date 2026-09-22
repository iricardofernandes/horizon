import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

function keyFor(master: Buffer, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(tenantId), 'fiscal-origin-payload-v1', 32),
  )
}

export function sealOrigin(
  master: Buffer,
  tenantId: string,
  intentId: string,
  payload: string,
): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(master, tenantId), nonce)
  cipher.setAAD(Buffer.from(`${tenantId}:${intentId}`))
  return Buffer.concat([
    Buffer.from([1]),
    nonce,
    cipher.update(payload, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

export function openOrigin(
  master: Buffer,
  tenantId: string,
  intentId: string,
  packed: Buffer,
): string {
  if (packed.length < 29 || packed[0] !== 1) throw new Error('Invalid fiscal origin envelope')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(master, tenantId), packed.subarray(1, 13))
  decipher.setAAD(Buffer.from(`${tenantId}:${intentId}`))
  decipher.setAuthTag(packed.subarray(-16))
  return Buffer.concat([decipher.update(packed.subarray(13, -16)), decipher.final()]).toString(
    'utf8',
  )
}
