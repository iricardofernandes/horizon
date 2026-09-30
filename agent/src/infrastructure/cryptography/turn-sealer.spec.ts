import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MasterKeyring } from './keyring'
import { AesGcmTurnSealer } from './turn-sealer'

describe('sealed turns (ADR 0068)', () => {
  const ring = () => MasterKeyring.of(randomBytes(32).toString('hex'))
  const sealer = new AesGcmTurnSealer(ring())
  const key = sealer.newKey('t', 'u')
  const place = { tenantId: 't', userId: 'u', conversationId: 'c', ordinal: 0 }

  it('opens what it sealed, and the ciphertext does not show the text', () => {
    const sealed = sealer.seal(key, place, 'Quanto devemos à Aurora?')
    expect(sealed.toString('latin1')).not.toContain('Aurora')
    expect(sealer.open(key, place, sealed)).toBe('Quanto devemos à Aurora?')
  })

  it('opens nothing in another place, for another person, or under another master key', () => {
    const sealed = sealer.seal(key, place, 'x')
    expect(() => sealer.open(key, { ...place, ordinal: 1 }, sealed)).toThrow()
    expect(() => sealer.open(key, { ...place, userId: 'v' }, sealed)).toThrow()
    expect(() => new AesGcmTurnSealer(ring()).open(key, place, sealed)).toThrow()
  })

  it('keeps every turn readable when the master key rotates and the person key is rewrapped', () => {
    const [old, current] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
    const before = new AesGcmTurnSealer(MasterKeyring.of(old))
    const wrapped = before.newKey('t', 'u')
    const sealed = before.seal(wrapped, place, 'Quanto devemos à Aurora?')
    const rewrapped = new AesGcmTurnSealer(MasterKeyring.of(current, old)).rewrap(wrapped, 't', 'u')
    // Once rewrapped, the old master key can go: the new one alone opens every turn.
    const after = new AesGcmTurnSealer(MasterKeyring.of(current))
    expect(after.open(rewrapped, place, sealed)).toBe('Quanto devemos à Aurora?')
    expect(() => after.open(wrapped, place, sealed)).toThrow()
  })
})
