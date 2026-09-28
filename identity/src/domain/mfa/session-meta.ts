/**
 * What a person sees of a session: a device label and a network, never the full address
 * (ADR 0061 §5).
 */
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/curl|node|undici/i, 'Script'],
]
const SYSTEMS: readonly [RegExp, string][] = [
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
]

const first = (userAgent: string, table: readonly [RegExp, string][]) =>
  table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null

export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device'
  const browser = first(userAgent, BROWSERS) ?? 'Browser'
  const system = first(userAgent, SYSTEMS)
  return system ? `${browser} on ${system}` : browser
}

/** An IPv4 address to its /24, an IPv6 address to its /48; anything else is dropped. */
export function ipPrefix(address: string | null | undefined): string | null {
  if (!address) return null
  const ip = address.replace(/^::ffff:/, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (ip.includes(':')) {
    const groups = ip
      .split(':')
      .filter((group) => group.length > 0)
      .slice(0, 3)
    return groups.length === 3 ? `${groups.join(':')}::/48` : null
  }
  return null
}
