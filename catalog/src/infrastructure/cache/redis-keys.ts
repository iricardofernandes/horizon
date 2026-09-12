const segment = (value: string): string => Buffer.from(value).toString('base64url')

/**
 * Redis is shared infrastructure, so the key layout is a cross-module contract rather
 * than a private detail. The `identity:denylist:*` names are Identity's, reproduced here
 * because every module consults the denylist itself (ADR 0021); they are copied, never
 * imported, and a change to them is a breaking change for every reader.
 */
export const redisKeys = {
  deniedToken: (jti: string): string => `identity:denylist:jti:${segment(jti)}`,
  deniedSubject: (subject: string): string => `identity:denylist:subject:${segment(subject)}`,
  idempotency: (scope: string): string => `catalog:idempotency:${scope}`,
}
