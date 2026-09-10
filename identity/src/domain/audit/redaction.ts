/**
 * Fields that never reach an audit entry in plaintext, and the function that removes
 * them.
 *
 * Redaction happens **before** hashing, and the list of what was redacted is part of the
 * hashed payload (ADR 0025) — see `HashedAuditPayload.redacted` for why that ordering is
 * load-bearing rather than incidental.
 *
 * The list is deliberately about *names*, not values: a rule that inspected values would
 * have to decide whether a given string looks like a secret, and it would be wrong in
 * both directions.
 */
const SENSITIVE_FIELDS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'secret',
  'secrethash',
  'secret_hash',
  'token',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'keymaterial',
  'key_material',
  'blindindex',
  'blind_index',
])

export interface Redacted {
  readonly data: Record<string, unknown> | null
  readonly fields: readonly string[]
}

/**
 * Strip sensitive members, recursively, reporting the paths that were removed.
 *
 * The reported paths are dotted from the record root (`credentials.password`), so a
 * reader of the entry can see *that* something was removed and *where*, which is what
 * makes the entry evidence rather than a gap.
 */
export function redact(data: Record<string, unknown> | null): Redacted {
  if (data === null) return { data: null, fields: [] }

  const fields: string[] = []
  const cleaned = walk(data, '', fields)
  return { data: cleaned, fields: fields.sort() }
}

function walk(
  input: Record<string, unknown>,
  prefix: string,
  fields: string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      fields.push(path)
      continue
    }
    output[key] = isPlainRecord(value) ? walk(value, path, fields) : value
  }

  return output
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value) || value instanceof Date) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
