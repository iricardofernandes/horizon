import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

function keyFor(master: Buffer, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(tenantId), 'fiscal-calculation-input-v1', 32),
  )
}

export function sealCalculationInput(
  master: Buffer,
  tenantId: string,
  calculationId: string,
  plaintext: string,
): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(master, tenantId), nonce)
  cipher.setAAD(Buffer.from(`${tenantId}:${calculationId}`))
  return Buffer.concat([
    Buffer.from([1]),
    nonce,
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

export function openCalculationInput(
  master: Buffer,
  tenantId: string,
  calculationId: string,
  packed: Buffer,
): string {
  if (packed.length < 29 || packed[0] !== 1) throw new Error('Invalid calculation input envelope')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(master, tenantId), packed.subarray(1, 13))
  decipher.setAAD(Buffer.from(`${tenantId}:${calculationId}`))
  decipher.setAuthTag(packed.subarray(-16))
  return Buffer.concat([decipher.update(packed.subarray(13, -16)), decipher.final()]).toString(
    'utf8',
  )
}
