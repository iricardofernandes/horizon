import { describe, expect, it } from 'vitest'
import { argumentsDigest, capResult, outcomeOf } from './results'

describe('capResult', () => {
  it('keeps a small single record whole', () => {
    const capped = capResult({ id: 'a', name: 'Coffee' }, 50, 1000)
    expect(capped).toMatchObject({ rows: null, truncated: false })
    expect(JSON.parse(capped.text)).toEqual({
      truncated: false,
      result: { id: 'a', name: 'Coffee' },
    })
  })

  it('cuts a bare array and an enveloped list to the row cap, and says so', () => {
    const bare = capResult([1, 2, 3, 4], 2, 1000)
    expect(bare).toMatchObject({ rows: 2, truncated: true })
    expect(JSON.parse(bare.text).result).toEqual([1, 2])
    const enveloped = capResult({ data: [1, 2, 3], total: 3 }, 2, 1000)
    expect(JSON.parse(enveloped.text).result).toEqual({ data: [1, 2], total: 3 })
    expect(capResult({ data: [1] }, 2, 1000)).toMatchObject({ rows: 1, truncated: false })
  })

  it('cuts text past the byte cap and never returns more', () => {
    const capped = capResult({ note: 'é'.repeat(500) }, 50, 100)
    expect(capped.truncated).toBe(true)
    expect(capped.bytes).toBeLessThanOrEqual(100)
    expect(capped.text).toContain('[truncated: the answer exceeded 100 bytes]')
    expect(capped.text).not.toContain('�')
  })
})

describe('argumentsDigest', () => {
  it('is the same whatever the key order, and differs with a value', () => {
    expect(argumentsDigest({ a: 1, b: 'x' })).toBe(argumentsDigest({ b: 'x', a: 1 }))
    expect(argumentsDigest({ a: 1 })).not.toBe(argumentsDigest({ a: 2 }))
    expect(argumentsDigest({})).toMatch(/^[0-9a-f]{64}$/)
  })
})

it('names outcomes from statuses', () => {
  expect([200, 403, 401, 404, 422, 500, 503].map(outcomeOf)).toEqual([
    'ok',
    'refused',
    'refused',
    'not-found',
    'refused',
    'failed',
    'failed',
  ])
})
