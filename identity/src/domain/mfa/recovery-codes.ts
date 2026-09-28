import { randomBytes } from 'node:crypto'
import { base32Encode } from './totp'

export const RECOVERY_CODE_COUNT = 10

/** `xxxxx-xxxxx`, 50 bits each, shown once and kept only as a keyed digest. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase()
    return `${code.slice(0, 5)}-${code.slice(5)}`
  })
}

/** What a person typed, the way it was digested: lower case, no spaces or dash. */
export function normalizedRecoveryCode(input: string): string | null {
  const clean = input.replace(/[\s-]/g, '').toLowerCase()
  return /^[a-z2-7]{10}$/.test(clean) ? clean : null
}
