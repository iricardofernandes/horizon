import { BlockList, isIP } from 'node:net'

/**
 * Where a webhook may go (Phase 90): the public internet, and nowhere else. A tenant chooses
 * the address and reads back each attempt's status and duration, so an internal address
 * would make the service a probe of the network it runs in.
 */
const RESERVED_IPV4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const)
  RESERVED_IPV4.addSubnet(network, prefix, 'ipv4')
// A list of its own: Node checks an IPv4 address against IPv6 rules as if IPv4-mapped, so
// one shared list would refuse every IPv4 address through the `::ffff:0:0/96` rule.
const RESERVED_IPV6 = new BlockList()
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped: refused, so no IPv4 address passes as an IPv6 one
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, Teredo included
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  RESERVED_IPV6.addSubnet(network, prefix, 'ipv6')

/** Hosts a development stack may call over plain HTTP, when it says so. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export class EndpointRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EndpointRefusedError'
  }
}

/** A unicast address on the public internet. Anything that is not an address is not one. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !RESERVED_IPV4.check(address, 'ipv4')
  if (family === 6) return !RESERVED_IPV6.check(address, 'ipv6')
  return false
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/** The host as an address when it is one, without the brackets of an IPv6 literal. */
export function literalAddress(hostname: string): string | null {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) === 0 ? null : bare
}

/**
 * What an endpoint URL must be before anything resolves it: HTTPS, no credentials, and no
 * address outside the public internet. A development stack may allow plain HTTP to its own
 * loopback, and nothing else.
 */
export function checkEndpoint(endpointUrl: string, allowLoopback: boolean): URL {
  let url: URL
  try {
    url = new URL(endpointUrl)
  } catch {
    throw new EndpointRefusedError('The endpoint is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new EndpointRefusedError('The endpoint must use HTTPS')
  if (url.username || url.password)
    throw new EndpointRefusedError('The endpoint must not carry credentials')
  if (isLoopbackHost(url.hostname)) {
    if (!allowLoopback) throw new EndpointRefusedError('The endpoint must be a public address')
    return url
  }
  if (url.protocol !== 'https:') throw new EndpointRefusedError('The endpoint must use HTTPS')
  const literal = literalAddress(url.hostname)
  if (literal !== null && !isPublicAddress(literal))
    throw new EndpointRefusedError('The endpoint must be a public address')
  return url
}
