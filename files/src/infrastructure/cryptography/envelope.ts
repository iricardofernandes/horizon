import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CipherContext, Envelope } from '@/application/ports'
import type { Owner } from '@/domain/attachment'

const VERSION = 1
const NONCE = 12
const TAG = 16

/** `version ‖ nonce ‖ ciphertext ‖ tag`, AES-256-GCM, with the context as associated data. */
function sealWith(key: Buffer, aad: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, cipher.getAuthTag()])
}

function openWith(key: Buffer, aad: string, sealed: Buffer): Buffer {
  if (sealed.length < 1 + NONCE + TAG || sealed[0] !== VERSION)
    throw new Error('Not a sealed value of a known version')
  const nonce = sealed.subarray(1, 1 + NONCE)
  const tag = sealed.subarray(sealed.length - TAG)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(sealed.subarray(1 + NONCE, sealed.length - TAG)),
    decipher.final(),
  ])
}

const ownerLabel = (tenantId: string, owner: Owner) => `${tenantId}:${owner.type}:${owner.id}`

/**
 * Envelope encryption (ADR 0060, Phase 65). The master key wraps owner keys; an owner key
 * wraps the data key of each of its files; a data key encrypts one file. Every layer binds
 * the tenant and owner, and the file layer the attachment, so nothing opens elsewhere.
 * Destroying an owner key leaves its files' data keys, and so the files, unreadable.
 */
export class AesGcmEnvelope implements Envelope {
  readonly #master: Buffer

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('The files master key must be 32 bytes')
    this.#master = Buffer.from(masterKey)
  }

  newOwnerKey(tenantId: string, owner: Owner): string {
    const key = randomBytes(32)
    return sealWith(this.#master, `owner-key:${ownerLabel(tenantId, owner)}`, key).toString(
      'base64',
    )
  }

  seal(wrappedOwnerKey: string, context: CipherContext, plaintext: Buffer) {
    const ownerKey = this.ownerKey(wrappedOwnerKey, context)
    const dataKey = randomBytes(32)
    const label = `${ownerLabel(context.tenantId, context.owner)}:${context.attachmentId}`
    return {
      object: sealWith(dataKey, `file:${label}`, plaintext),
      wrappedDataKey: sealWith(ownerKey, `data-key:${label}`, dataKey).toString('base64'),
    }
  }

  open(wrappedOwnerKey: string, context: CipherContext, wrappedDataKey: string, object: Buffer) {
    const ownerKey = this.ownerKey(wrappedOwnerKey, context)
    const label = `${ownerLabel(context.tenantId, context.owner)}:${context.attachmentId}`
    const dataKey = openWith(ownerKey, `data-key:${label}`, Buffer.from(wrappedDataKey, 'base64'))
    return openWith(dataKey, `file:${label}`, object)
  }

  private ownerKey(wrapped: string, context: CipherContext): Buffer {
    return openWith(
      this.#master,
      `owner-key:${ownerLabel(context.tenantId, context.owner)}`,
      Buffer.from(wrapped, 'base64'),
    )
  }
}

/** The master key from the environment: 64 hex characters or 32 bytes of base64. */
export function masterKeyOf(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('FILES_MASTER_KEY must hold 32 bytes')
  return key
}
