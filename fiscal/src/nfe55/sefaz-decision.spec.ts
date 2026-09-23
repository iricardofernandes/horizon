import { describe, expect, it } from 'vitest'
import { classifySefazResponse } from './sefaz-decision'
import type { SefazResponse } from './sefaz-soap'

const base: SefazResponse = {
  service: 'authorization',
  statusCode: '104',
  reason: 'Lote processado',
  receipt: null,
  accessKey: '3'.repeat(44),
  protocolNumber: '1'.repeat(15),
  documentStatusCode: '100',
  eventStatusCode: null,
  response: Buffer.from('<soap/>'),
  payload: Buffer.from('<response/>'),
  protocol: Buffer.from('<protocol/>'),
}

function classify(changes: Partial<SefazResponse>) {
  return classifySefazResponse({ ...base, ...changes })
}

describe('conservative SEFAZ homologation decision', () => {
  it('authorizes only a complete observed 100 protocol', () => {
    expect(classify({})).toBe('authorized')
    expect(classify({ service: 'receipt' })).toBe('authorized')
    expect(classify({ service: 'protocol', statusCode: '100' })).toBe('authorized')
    expect(classify({ protocol: null })).toBe('unknown')
    expect(classify({ protocolNumber: null })).toBe('unknown')
    expect(classify({ accessKey: null })).toBe('unknown')
    expect(classify({ documentStatusCode: '150' })).toBe('unknown')
  })

  it('retains nonfinal and ambiguous codes without a final decision', () => {
    expect(classify({ statusCode: '103', receipt: '1'.repeat(15) })).toBe('pending')
    expect(classify({ service: 'receipt', statusCode: '105' })).toBe('pending')
    expect(classify({ service: 'protocol', statusCode: '106' })).toBe('unknown')
    expect(classify({ statusCode: '204' })).toBe('unknown')
    expect(classify({ statusCode: '999' })).toBe('unknown')
  })

  it('recognizes only reviewed rejection and cancellation combinations', () => {
    expect(classify({ statusCode: '215' })).toBe('rejected')
    expect(classify({ documentStatusCode: '225' })).toBe('rejected')
    expect(classify({ documentStatusCode: '204' })).toBe('unknown')
    expect(classify({ service: 'event', statusCode: '128', eventStatusCode: '135' })).toBe(
      'cancelled',
    )
    expect(classify({ service: 'event', statusCode: '128', eventStatusCode: '136' })).toBe(
      'unknown',
    )
    expect(
      classify({ service: 'event', statusCode: '128', eventStatusCode: '135', protocol: null }),
    ).toBe('unknown')
  })

  it('classifies status observations separately from document outcomes', () => {
    expect(classify({ service: 'status', statusCode: '107' })).toBe('available')
    expect(classify({ service: 'status', statusCode: '108' })).toBe('unavailable')
    expect(classify({ service: 'status', statusCode: '109' })).toBe('unavailable')
    expect(classify({ service: 'status', statusCode: '100' })).toBe('unknown')
  })
})
