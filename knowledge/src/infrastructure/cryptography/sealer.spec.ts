import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AesGcmSealer, masterKeyOf } from './sealer'

describe('sealed chunks (ADR 0068)', () => {
  const sealer = new AesGcmSealer(randomBytes(32))
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

  it('reads the master key as hex or base64, and refuses another length', () => {
    expect(masterKeyOf('00'.repeat(32))).toHaveLength(32)
    expect(masterKeyOf(randomBytes(32).toString('base64'))).toHaveLength(32)
    expect(() => masterKeyOf('00'.repeat(16))).toThrow()
  })
})
