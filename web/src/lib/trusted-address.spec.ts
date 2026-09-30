import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { clientAddress, trustedHops } = createRequire(import.meta.url)(
  '../../trusted-address.cjs',
) as {
  clientAddress: (forwardedFor: string | undefined, socketAddress: string, hops: number) => string
  trustedHops: (value: string | undefined) => number
}

describe('the browser address the web server vouches for', () => {
  it('is the connection’s own address when browsers connect directly', () => {
    expect(clientAddress(undefined, '203.0.113.7', 0)).toBe('203.0.113.7')
  })

  it('ignores an address the browser wrote itself', () => {
    expect(clientAddress('198.51.100.1', '203.0.113.7', 0)).toBe('203.0.113.7')
    expect(clientAddress('198.51.100.1, 198.51.100.2', '203.0.113.7', 0)).toBe('203.0.113.7')
  })

  it('takes the address the outermost trusted proxy saw', () => {
    // browser-written, then what the load balancer saw; the socket is the load balancer.
    expect(clientAddress('198.51.100.1, 203.0.113.9', '10.0.0.5', 1)).toBe('203.0.113.9')
  })

  it('falls back to what trusted hops wrote when the chain is shorter than configured', () => {
    expect(clientAddress(undefined, '10.0.0.5', 2)).toBe('10.0.0.5')
  })

  it('refuses anything that is not an address', () => {
    expect(clientAddress('not-an-ip', '10.0.0.5', 1)).toBe('10.0.0.5')
  })

  it('writes an IPv4 address mapped into IPv6 as IPv4', () => {
    expect(clientAddress(undefined, '::ffff:172.23.0.1', 0)).toBe('172.23.0.1')
  })

  it('accepts only a small whole number of hops', () => {
    expect(trustedHops(undefined)).toBe(0)
    expect(trustedHops('1')).toBe(1)
    expect(() => trustedHops('-1')).toThrow()
    expect(() => trustedHops('x')).toThrow()
  })
})
