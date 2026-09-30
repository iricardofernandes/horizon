import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const LEGACY = 1
const NAMED = 2
const ID = 4
const NONCE = 12
const TAG = 16

/** A master key's name: the first bytes of a digest of it, never the key itself. */
function idOf(key: Buffer): string {
  return createHash('sha256')
    .update('horizon-master-key:')
    .update(key)
    .digest()
    .subarray(0, ID)
    .toString('hex')
}

/** 64 hex characters or 32 bytes of base64. */
export function keyOf(value: string): Buffer {
  const trimmed = value.trim()
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64')
  if (key.length !== 32) throw new Error('A master key must hold 32 bytes')
  return key
}

function open(key: Buffer, aad: string, nonce: Buffer, body: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/**
 * The name of the master key a wrapped value was wrapped under, or null for one wrapped
 * before master keys had names (Phase 81).
 */
export function masterKeyIdOf(wrapped: string): string | null {
  const bytes = Buffer.from(wrapped, 'base64')
  return bytes[0] === NAMED && bytes.length > 1 + ID
    ? bytes.subarray(1, 1 + ID).toString('hex')
    : null
}

/**
 * The master keys (ADR 0068, Phase 81): the current one wraps, and every one listed opens.
 * A wrapped value is `2 ‖ key name ‖ nonce ‖ ciphertext ‖ tag`, with the name bound into the
 * associated data. One wrapped before names existed (`1 ‖ nonce ‖ …`) is opened by whichever
 * listed key authenticates it. Rotation lists the old key as previous, lets every wrapped key
 * be rewrapped under the new one, and then drops the old key.
 */
export class MasterKeyring {
  readonly currentId: string
  readonly #keys: ReadonlyMap<string, Buffer>

  private constructor(keys: readonly Buffer[]) {
    const named = new Map<string, Buffer>()
    for (const key of keys) {
      const id = idOf(key)
      if (named.has(id)) throw new Error('The same master key is listed twice')
      named.set(id, Buffer.from(key))
    }
    const [current] = named.keys()
    if (!current) throw new Error('A current master key is required')
    this.currentId = current
    this.#keys = named
  }

  /** The current key, and the previous ones as a comma-separated list. */
  static of(current: string, previous = ''): MasterKeyring {
    const earlier = previous
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    return new MasterKeyring([keyOf(current), ...earlier.map(keyOf)])
  }

  get size(): number {
    return this.#keys.size
  }

  wrap(aad: string, plaintext: Buffer): string {
    const key = this.#keys.get(this.currentId) as Buffer
    const nonce = randomBytes(NONCE)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(`${aad}:${this.currentId}`, 'utf8'))
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([
      Buffer.from([NAMED]),
      Buffer.from(this.currentId, 'hex'),
      nonce,
      body,
      cipher.getAuthTag(),
    ]).toString('base64')
  }

  unwrap(aad: string, wrapped: string): Buffer {
    const bytes = Buffer.from(wrapped, 'base64')
    if (bytes[0] === NAMED && bytes.length >= 1 + ID + NONCE + TAG) {
      const id = bytes.subarray(1, 1 + ID).toString('hex')
      const key = this.#keys.get(id)
      if (!key) throw new Error('Wrapped under a master key this ring does not hold')
      const start = 1 + ID
      return open(
        key,
        `${aad}:${id}`,
        bytes.subarray(start, start + NONCE),
        bytes.subarray(start + NONCE, bytes.length - TAG),
        bytes.subarray(bytes.length - TAG),
      )
    }
    if (bytes[0] === LEGACY && bytes.length >= 1 + NONCE + TAG) {
      const nonce = bytes.subarray(1, 1 + NONCE)
      const body = bytes.subarray(1 + NONCE, bytes.length - TAG)
      const tag = bytes.subarray(bytes.length - TAG)
      for (const key of this.#keys.values()) {
        try {
          return open(key, aad, nonce, body, tag)
        } catch {
          // Not this key: the tag tells, and the next one is tried.
        }
      }
      throw new Error('Wrapped under a master key this ring does not hold')
    }
    throw new Error('Not a wrapped key of a known version')
  }

  /** The same data key, wrapped under the current master key; unchanged when it already is. */
  rewrap(aad: string, wrapped: string): string {
    if (masterKeyIdOf(wrapped) === this.currentId) return wrapped
    return this.wrap(aad, this.unwrap(aad, wrapped))
  }
}
