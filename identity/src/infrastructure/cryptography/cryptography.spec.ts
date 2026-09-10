import { randomBytes } from 'node:crypto'

import { parseOptions } from '@node-rs/argon2'

import { AesGcmSecretBox } from './aes-gcm-secret-box'
import { Argon2PasswordHasher } from './argon2-password-hasher'
import { CryptoSecretGenerator } from './crypto-secret-generator'
import { HmacTokenDigest } from './hmac-token-digest'
import { SystemClock } from './system-clock'

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher()

  it('hashes with the Argon2id policy and unique salts', async () => {
    const first = await hasher.hash('correct horse battery staple')
    const second = await hasher.hash('correct horse battery staple')

    expect(first).not.toBe(second)
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(parseOptions(first)).toMatchObject({ outputLen: 32, saltLen: 16 })
    expect(await hasher.verify(first, 'correct horse battery staple')).toBe(true)
    expect(await hasher.verify(first, 'incorrect horse battery staple')).toBe(false)
  })

  it('uses the entire UTF-8 passphrase beyond 72 bytes', async () => {
    const prefix = 'á'.repeat(72)
    const encoded = await hasher.hash(`${prefix}one`)

    expect(await hasher.verify(encoded, `${prefix}one`)).toBe(true)
    expect(await hasher.verify(encoded, `${prefix}two`)).toBe(false)
  })

  it.each(['', 'corrupt', '$argon2id$v=19$m=19456,t=2,p=1$bad$bad'])(
    'returns false for malformed stored hashes: %j',
    async (encoded) => {
      expect(await hasher.verify(encoded, 'password')).toBe(false)
    },
  )

  it('performs dummy verification without revealing a result', async () => {
    await expect(hasher.verifyDummy()).resolves.toBeUndefined()
  })

  it.each([
    { memoryKib: 1024, timeCost: 2, parallelism: 1 },
    { memoryKib: 19456, timeCost: 1, parallelism: 1 },
    { memoryKib: 19456, timeCost: 2, parallelism: 0 },
    { memoryKib: 19456, timeCost: 2.5, parallelism: 1 },
    { memoryKib: 19456, timeCost: 2, parallelism: 256 },
  ])('refuses a policy below the minimum or outside the native range: %j', (policy) => {
    expect(() => new Argon2PasswordHasher(policy)).toThrow()
  })
})

describe('AesGcmSecretBox', () => {
  const box = new AesGcmSecretBox()
  const secret = randomBytes(32).toString('base64url')

  it.each(['replacement-token', '', 'substituição 🔐'])('round-trips %j', (plaintext) => {
    const sealed = box.seal(secret, plaintext)

    expect(box.open(secret, sealed)).toBe(plaintext)
    expect(box.open('wrong-token', sealed)).toBeNull()
    expect(box.seal(secret, plaintext)).not.toBe(sealed)
  })

  it('does not allow the stored digest to unlock the replacement', () => {
    const digest = new HmacTokenDigest(randomBytes(32)).digest(secret)

    expect(box.open(digest, box.seal(secret, 'replacement-token'))).toBeNull()
  })

  it.each([1, 2, 3, 4])('authenticates envelope component %i', (index) => {
    const parts = box.seal(secret, 'replacement-token').split('.')
    const part = parts[index]
    if (part === undefined) throw new Error('Missing ciphertext component')
    const bytes = Buffer.from(part, 'base64url')
    bytes[0] = (bytes[0] ?? 0) ^ 1
    parts[index] = bytes.toString('base64url')

    expect(box.open(secret, parts.join('.'))).toBeNull()
  })

  it.each(['', 'v2.a.b.c.d', 'v1.a.b.c.d', 'v1.a.b.c', 'v1.a.b.c.d.e'])(
    'rejects malformed or unsupported envelopes: %j',
    (sealed) => {
      expect(box.open(secret, sealed)).toBeNull()
    },
  )

  it('rejects noncanonical base64url even when the decoded bytes would be unchanged', () => {
    const parts = box.seal(secret, 'replacement-token').split('.')
    parts[1] += '='

    expect(box.open(secret, parts.join('.'))).toBeNull()
  })
})

describe('HmacTokenDigest', () => {
  it('provides stable fixed-size digests with key and input separation', () => {
    const first = new HmacTokenDigest(randomBytes(32))
    const second = new HmacTokenDigest(randomBytes(32))

    expect(first.digest('token')).toMatch(/^[a-f0-9]{64}$/)
    expect(first.digest('token')).toBe(first.digest('token'))
    expect(first.digest('token')).not.toBe(first.digest('other-token'))
    expect(first.digest('token')).not.toBe(second.digest('token'))
  })

  it('copies caller-owned key material and refuses short keys', () => {
    const key = randomBytes(32)
    const digest = new HmacTokenDigest(key)
    const original = digest.digest('token')
    key.fill(0)

    expect(digest.digest('token')).toBe(original)
    expect(() => new HmacTokenDigest(randomBytes(16))).toThrow()
  })
})

describe('CryptoSecretGenerator', () => {
  const generator = new CryptoSecretGenerator()

  it('produces distinct URL-safe refresh tokens carrying 32 bytes', () => {
    const tokens = Array.from({ length: 100 }, () => generator.token(32))

    expect(new Set(tokens).size).toBe(tokens.length)
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    }
  })

  it('produces API-key segments, data-subject keys and unique token identifiers', () => {
    expect(generator.alphanumeric(24)).toMatch(/^[A-Za-z0-9]{24}$/)
    expect(Buffer.from(generator.keyMaterial(), 'base64')).toHaveLength(32)
    expect(generator.identifier()).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    )
    expect(generator.identifier()).not.toBe(generator.identifier())
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid output sizes: %j',
    (size) => {
      expect(() => generator.token(size)).toThrow()
      expect(() => generator.alphanumeric(size)).toThrow()
    },
  )
})

describe('SystemClock', () => {
  it('reports a fresh wall-clock value', () => {
    const before = Date.now()
    const now = new SystemClock().now()

    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(Date.now())
  })
})
