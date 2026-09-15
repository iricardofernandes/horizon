export function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' }
}

/** Money- and stock-moving writes carry an idempotency key (ADR 0028). */
export function idempotentJsonHeaders(): Record<string, string> {
  return { ...jsonHeaders(), 'idempotency-key': crypto.randomUUID() }
}
