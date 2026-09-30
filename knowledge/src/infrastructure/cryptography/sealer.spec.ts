import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MasterKeyring } from './keyring'
import { AesGcmSealer } from './sealer'

describe('sealed chunks (ADR 0068)', () => {
  const sealer = new AesGcmSealer(MasterKeyring.of(randomBytes(32).toString('hex')))
  const key = sealer.newKey('tenant-a', 'file-1')

  it('opens what it sealed, and the ciphertext does not show the text', () => {
    const sealed = sealer.seal(key, 'tenant-a', 'file-1', 3, 'Maria Silva, CPF 123')
    expect(sealed.toString('latin1')).not.toContain('Maria')
    expect(sealer.open(key, 'tenant-a', 'file-1', 3, sealed)).toBe('Maria Silva, CPF 123')
  })

  it('opens nothing under another tenant, file or position', () => {
    const sealed = sealer.seal(key, 'tenant-a', 'file-1', 0, 'texto')
    expect(() => sealer.open(key, 'tenant-a', 'file-1', 1, sealed)).toThrow()
    expect(() => sealer.open(key, 'tenant-b', 'file-1', 0, sealed)).toThrow()
    expect(() => sealer.open(key, 'tenant-a', 'file-2', 0, sealed)).toThrow()
  })

  it('keeps every chunk readable when the master key rotates and the data key is rewrapped', () => {
    const [old, current] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
    const before = new AesGcmSealer(MasterKeyring.of(old))
    const wrapped = before.newKey('tenant-a', 'file-1')
    const sealed = before.seal(wrapped, 'tenant-a', 'file-1', 0, 'texto')
    const during = new AesGcmSealer(MasterKeyring.of(current, old))
    const rewrapped = during.rewrap(wrapped, 'tenant-a', 'file-1')
    expect(rewrapped).not.toBe(wrapped)
    // Once rewrapped, the old master key can go: the new one alone opens every chunk.
    const after = new AesGcmSealer(MasterKeyring.of(current))
    expect(after.open(rewrapped, 'tenant-a', 'file-1', 0, sealed)).toBe('texto')
    expect(() => after.open(wrapped, 'tenant-a', 'file-1', 0, sealed)).toThrow()
  })
})
