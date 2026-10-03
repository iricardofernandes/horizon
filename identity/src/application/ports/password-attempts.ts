/**
 * Failed password attempts per account name (Phase 92). Counted by the e-mail that was
 * typed, known or not, so the count says nothing about which accounts exist.
 */
export abstract class PasswordAttempts {
  abstract failures(email: string): Promise<number>
  abstract failed(email: string): Promise<void>
  abstract cleared(email: string): Promise<void>
}

const FREE_ATTEMPTS = 3
const FIRST_DELAY_MS = 500
const LONGEST_DELAY_MS = 8000

/**
 * How long the next attempt waits: nothing for the first few mistakes, then twice as long
 * each time, up to eight seconds. A delay, never a lockout: nobody can shut a person out
 * of their account by guessing at it.
 */
export function penaltyMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0
  return Math.min(FIRST_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS), LONGEST_DELAY_MS)
}
