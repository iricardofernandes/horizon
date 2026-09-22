import { createHash } from 'node:crypto'

/** RFC 8785-style subset for Horizon wire values: sorted keys and JSON-safe integers only. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError('Canonical JSON accepts only safe integer numbers')
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key]
      if (member === undefined) continue
      output[key] = normalize(member)
    }
    return output
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`)
}
