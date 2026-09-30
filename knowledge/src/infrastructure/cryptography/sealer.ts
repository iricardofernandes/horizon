import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Sealer } from '@/application/ports'
import type { MasterKeyring } from './keyring'

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
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + NONCE))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG))
  return Buffer.concat([
    decipher.update(sealed.subarray(1 + NONCE, sealed.length - TAG)),
    decipher.final(),
  ])
}

/**
 * Chunk text sealed under a data key of its document, wrapped by the master key (ADR 0068).
 * Every layer binds the tenant and the attachment, and each chunk its position, so nothing
 * opens elsewhere; deleting the document destroys the key, and with it every chunk. The
 * master keys form a ring, so they can be rotated (Phase 81).
 */
export class AesGcmSealer extends Sealer {
  readonly #keyring: MasterKeyring

  constructor(keyring: MasterKeyring) {
    super()
    this.#keyring = keyring
  }

  /** The name of the master key new data keys are wrapped under. */
  get masterKeyId(): string {
    return this.#keyring.currentId
  }

  newKey(tenantId: string, attachmentId: string): string {
    return this.#keyring.wrap(documentKeyAad(tenantId, attachmentId), randomBytes(32))
  }

  /** The document's data key, wrapped under the current master key (Phase 81). */
  rewrap(wrappedKey: string, tenantId: string, attachmentId: string): string {
    return this.#keyring.rewrap(documentKeyAad(tenantId, attachmentId), wrappedKey)
  }

  seal(wrappedKey: string, tenantId: string, attachmentId: string, ordinal: number, text: string) {
    return sealWith(
      this.keyOf(wrappedKey, tenantId, attachmentId),
      `chunk:${tenantId}:${attachmentId}:${ordinal}`,
      Buffer.from(text, 'utf8'),
    )
  }

  open(
    wrappedKey: string,
    tenantId: string,
    attachmentId: string,
    ordinal: number,
    sealed: Buffer,
  ) {
    return openWith(
      this.keyOf(wrappedKey, tenantId, attachmentId),
      `chunk:${tenantId}:${attachmentId}:${ordinal}`,
      sealed,
    ).toString('utf8')
  }

  private keyOf(wrappedKey: string, tenantId: string, attachmentId: string): Buffer {
    return this.#keyring.unwrap(documentKeyAad(tenantId, attachmentId), wrappedKey)
  }
}

const documentKeyAad = (tenantId: string, attachmentId: string) =>
  `document-key:${tenantId}:${attachmentId}`
