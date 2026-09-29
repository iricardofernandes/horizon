import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { type TurnPlace, TurnSealer } from '@/application/assistant-ports'

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

const turnAad = (place: TurnPlace) =>
  `turn:${place.tenantId}:${place.userId}:${place.conversationId}:${place.ordinal}`

/**
 * A person's conversation turns, sealed under a data key of theirs, wrapped by the master key
 * (ADR 0068). Each turn binds its tenant, person, conversation and place; erasing the person
 * destroys the key, and every turn with it.
 */
export class AesGcmTurnSealer extends TurnSealer {
  readonly #master: Buffer

  constructor(masterKey: Buffer) {
    super()
    if (masterKey.length !== 32) throw new Error('The assistant master key must be 32 bytes')
    this.#master = Buffer.from(masterKey)
  }

  newKey(tenantId: string, userId: string): string {
    return sealWith(this.#master, `person-key:${tenantId}:${userId}`, randomBytes(32)).toString(
      'base64',
    )
  }

  seal(wrappedKey: string, place: TurnPlace, plaintext: string): Buffer {
    return sealWith(this.keyOf(wrappedKey, place), turnAad(place), Buffer.from(plaintext, 'utf8'))
  }

  open(wrappedKey: string, place: TurnPlace, sealed: Buffer): string {
    return openWith(this.keyOf(wrappedKey, place), turnAad(place), sealed).toString('utf8')
  }

  private keyOf(wrappedKey: string, place: TurnPlace): Buffer {
    return openWith(
      this.#master,
      `person-key:${place.tenantId}:${place.userId}`,
      Buffer.from(wrappedKey, 'base64'),
    )
  }
}

/** The master key from the environment: 64 hex characters or 32 bytes of base64. */
export function masterKeyOf(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('ASSISTANT_MASTER_KEY must hold 32 bytes')
  return key
}
