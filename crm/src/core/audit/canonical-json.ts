/**
 * Canonical JSON — the serialisation the audit hash chain is computed over (ADR 0025).
 *
 * A chain that verifies on one machine and not another is worse than no chain, so this
 * is deliberately narrow and deliberately total:
 *
 *   - **Object keys are sorted** by UTF-16 code unit, recursively. `JSON.stringify`
 *     preserves insertion order, so the same fact serialised by two code paths would
 *     otherwise hash differently.
 *   - **`undefined` and absent are the same thing.** A property whose value is
 *     `undefined` is omitted, exactly as `JSON.stringify` omits it, so a round trip
 *     through JSON does not change the digest.
 *   - **Numbers must be finite**, and integers serialise without an exponent.
 *     `NaN` and `Infinity` have no JSON representation and become `null` under
 *     `JSON.stringify` — silently, which is the failure mode this function exists to
 *     remove. They throw here instead.
 *   - **`bigint` serialises as a decimal string.** `JSON.stringify` throws on it
 *     (ADR 0010 makes money a `bigint`, so this is not hypothetical).
 *   - **`Date` serialises as an ISO 8601 UTC instant** with milliseconds, always
 *     (ADR 0011).
 *
 * Anything else — a function, a symbol, a `Map`, a class instance — throws. Guessing
 * would produce a digest that depends on which guess was made.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value)
}

function serialise(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serialiseNumber(value)
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'object':
      return serialiseObject(value)
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
  }
}

function serialiseNumber(value: number): string {
  if (!Number.isFinite(value))
    throw new TypeError('canonicalJson: NaN and Infinity have no canonical form')
  // `-0` and `0` are the same number to every reader; they must hash the same.
  if (Object.is(value, -0)) return '0'
  return JSON.stringify(value)
}

function serialiseObject(value: object): string {
  if (value instanceof Date) return JSON.stringify(toIsoUtc(value))
  if (Array.isArray(value)) return `[${value.map((item) => serialise(item ?? null)).join(',')}]`
  if (isPlainObject(value)) return serialiseRecord(value)
  throw new TypeError(`canonicalJson: unsupported object ${value.constructor.name}`)
}

function serialiseRecord(value: Record<string, unknown>): string {
  const members = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${serialise(value[key])}`)
  return `{${members.join(',')}}`
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function toIsoUtc(value: Date): string {
  if (Number.isNaN(value.getTime()))
    throw new TypeError('canonicalJson: an invalid Date has no canonical form')
  return value.toISOString()
}
