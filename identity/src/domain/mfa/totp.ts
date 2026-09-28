import { createHmac, randomBytes } from 'node:crypto'

/** RFC 6238 with the parameters every authenticator app supports: SHA-1, 6 digits, 30 s. */
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** One step either way, for a clock a little off. */
export const TOTP_DRIFT_STEPS = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const character of clean) {
    const index = BASE32.indexOf(character)
    if (index < 0) throw new Error('Not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** 20 random bytes, the size RFC 4226 recommends for HMAC-SHA-1. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS)
}

/** The HOTP value of one counter (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0)
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * The time step a code matches, or null. A step at or before `lastUsedStep` is refused,
 * so a code seen once never opens anything again.
 */
export function matchingStep(
  secret: string,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const current = stepAt(now)
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    const step = current + drift
    if (lastUsedStep !== null && step <= lastUsedStep) continue
    if (hotp(key, step) === code) return step
  }
  return null
}

/** What an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${query}`
}
