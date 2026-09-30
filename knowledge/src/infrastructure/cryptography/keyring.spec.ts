import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MasterKeyring, masterKeyIdOf } from './keyring'

const hex = () => randomBytes(32).toString('hex')

/** A key wrapped as before Phase 81: `1 ‖ nonce ‖ ciphertext ‖ tag`, naming no master key. */
function wrappedTheOldWay(master: string, aad: string, plaintext: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(master, 'hex'), nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([1]), nonce, body, cipher.getAuthTag()]).toString('base64')
}

describe('the master keyring (Phase 81)', () => {
  it('wraps under the current key, and names it in the wrapped value', () => {
    const ring = MasterKeyring.of(hex())
    const wrapped = ring.wrap('document-key:t:a', Buffer.from('data key'))
    expect(masterKeyIdOf(wrapped)).toBe(ring.currentId)
    expect(ring.unwrap('document-key:t:a', wrapped).toString()).toBe('data key')
  })

  it('opens what an earlier key wrapped, once that key is listed as previous', () => {
    const old = hex()
    const before = MasterKeyring.of(old)
    const wrapped = before.wrap('aad', Buffer.from('secret'))
    const after = MasterKeyring.of(hex(), old)
    expect(after.currentId).not.toBe(before.currentId)
    expect(after.unwrap('aad', wrapped).toString()).toBe('secret')
    expect(masterKeyIdOf(after.rewrap('aad', wrapped))).toBe(after.currentId)
  })

  it('opens a key wrapped before master keys had names, and rewraps it under a name', () => {
    const old = hex()
    const legacy = wrappedTheOldWay(old, 'aad', Buffer.from('secret'))
    expect(masterKeyIdOf(legacy)).toBeNull()
    const ring = MasterKeyring.of(hex(), old)
    expect(ring.unwrap('aad', legacy).toString()).toBe('secret')
    expect(masterKeyIdOf(ring.rewrap('aad', legacy))).toBe(ring.currentId)
  })

  it('refuses a key wrapped by a master key the ring no longer holds', () => {
    const wrapped = MasterKeyring.of(hex()).wrap('aad', Buffer.from('secret'))
    expect(() => MasterKeyring.of(hex()).unwrap('aad', wrapped)).toThrow()
  })

  it('binds the context: a wrapped key does not open under another', () => {
    const ring = MasterKeyring.of(hex())
    const wrapped = ring.wrap('document-key:t:a', Buffer.from('secret'))
    expect(() => ring.unwrap('document-key:t:b', wrapped)).toThrow()
  })

  it('leaves a key already under the current master as it is', () => {
    const ring = MasterKeyring.of(hex())
    const wrapped = ring.wrap('aad', Buffer.from('secret'))
    expect(ring.rewrap('aad', wrapped)).toBe(wrapped)
  })

  it('accepts hex or base64 keys, and refuses a wrong length or the same key twice', () => {
    const key = randomBytes(32)
    expect(MasterKeyring.of(key.toString('base64')).currentId).toBe(
      MasterKeyring.of(key.toString('hex')).currentId,
    )
    expect(() => MasterKeyring.of('abcd')).toThrow()
    expect(() => MasterKeyring.of(key.toString('hex'), key.toString('base64'))).toThrow()
  })

  it('reads previous keys as a comma-separated list, ignoring blanks', () => {
    const [a, b] = [hex(), hex()]
    const ring = MasterKeyring.of(hex(), ` ${a}, ,${b} `)
    expect(ring.size).toBe(3)
  })
})
