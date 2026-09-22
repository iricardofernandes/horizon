import { describe, expect, it } from 'vitest'
import { canonicalDigest, canonicalJson } from './canonical-json'

describe('canonical JSON', () => {
  it('sorts object keys recursively but preserves array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, rows: ['b', 'a'] })).toBe(
      '{"a":{"b":3,"y":2},"rows":["b","a"],"z":1}',
    )
  })

  it('produces the same digest for equivalent key order', () => {
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(canonicalDigest({ a: 1, b: 2 }))
  })

  it('rejects floating-point values', () => {
    expect(() => canonicalJson({ unsafe: 1.5 })).toThrow('safe integer')
  })
})
