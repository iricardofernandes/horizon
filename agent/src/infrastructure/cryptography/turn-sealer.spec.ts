import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AesGcmTurnSealer, masterKeyOf } from './turn-sealer'

describe('sealed turns (ADR 0068)', () => {
  const sealer = new AesGcmTurnSealer(randomBytes(32))
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
    expect(() => new AesGcmTurnSealer(randomBytes(32)).open(key, place, sealed)).toThrow()
  })

  it('reads the master key as hex or base64, of 32 bytes only', () => {
    expect(masterKeyOf('ab'.repeat(32))).toHaveLength(32)
    expect(masterKeyOf(randomBytes(32).toString('base64'))).toHaveLength(32)
    expect(() => masterKeyOf('abc')).toThrow()
    expect(() => new AesGcmTurnSealer(randomBytes(16))).toThrow()
  })
})
