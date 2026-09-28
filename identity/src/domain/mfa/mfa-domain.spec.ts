import { describe, expect, it } from 'vitest'
import {
  ended,
  INVITATION_TTL_MS,
  type Invitation,
  isUsable,
  maskEmail,
  resent,
  statusAt,
} from './invitation'
import { enrollBy, hasSecondFactor, isValidGraceDays, mfaRequiredFor } from './mfa-policy'
import { newRecoveryCodes, normalizedRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes'
import { deviceLabel, ipPrefix } from './session-meta'
import {
  base32Decode,
  base32Encode,
  hotp,
  matchingStep,
  newTotpSecret,
  otpauthUri,
  stepAt,
} from './totp'

// RFC 6238 appendix B: the SHA-1 seed is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors, truncated to six digits', () => {
    const key = base32Decode(RFC_SECRET)
    expect(hotp(key, stepAt(new Date(59_000)))).toBe('287082')
    expect(hotp(key, stepAt(new Date(1_111_111_109_000)))).toBe('081804')
    expect(hotp(key, stepAt(new Date(1_234_567_890_000)))).toBe('005924')
    expect(hotp(key, stepAt(new Date(20_000_000_000_000)))).toBe('353130')
  })

  it('accepts one step of drift, and never the same step twice', () => {
    const now = new Date(1_234_567_890_000)
    const previous = hotp(base32Decode(RFC_SECRET), stepAt(now) - 1)
    const step = matchingStep(RFC_SECRET, previous, now, null)
    expect(step).toBe(stepAt(now) - 1)
    expect(matchingStep(RFC_SECRET, previous, now, step)).toBeNull()
    const twoAgo = hotp(base32Decode(RFC_SECRET), stepAt(now) - 2)
    expect(matchingStep(RFC_SECRET, twoAgo, now, null)).toBeNull()
    expect(matchingStep(RFC_SECRET, 'abcdef', now, null)).toBeNull()
  })

  it('makes 160-bit secrets and a URI an authenticator reads', () => {
    const secret = newTotpSecret()
    expect(base32Decode(secret)).toHaveLength(20)
    expect(base32Encode(base32Decode(secret))).toBe(secret)
    const uri = otpauthUri(secret, 'Horizon', 'ana@empresa.com')
    expect(uri).toMatch(/^otpauth:\/\/totp\/Horizon%3Aana%40empresa\.com\?secret=/)
    expect(uri).toContain('period=30')
    expect(() => base32Decode('01!')).toThrow()
  })
})

describe('recovery codes', () => {
  it('makes ten distinct codes and reads them back however they are typed', () => {
    const codes = newRecoveryCodes()
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT)
    expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/)
    expect(normalizedRecoveryCode(' ABCDE-fghij ')).toBe('abcdefghij')
    expect(normalizedRecoveryCode('abc')).toBeNull()
  })
})

describe('the MFA policy', () => {
  it('covers administrators or everyone, and counts grace from the change', () => {
    const admins = {
      policy: 'admins' as const,
      graceDays: 7,
      changedAt: new Date('2026-09-01T00:00:00Z'),
    }
    expect(mfaRequiredFor(admins, [{ role: 'viewer' }])).toBe(false)
    expect(mfaRequiredFor(admins, [{ role: 'viewer' }, { role: 'owner' }])).toBe(true)
    expect(mfaRequiredFor({ ...admins, policy: 'everyone' }, [])).toBe(true)
    expect(mfaRequiredFor({ ...admins, policy: 'off' }, [{ role: 'owner' }])).toBe(false)
    expect(enrollBy(admins)?.toISOString()).toBe('2026-09-08T00:00:00.000Z')
    expect(enrollBy({ ...admins, policy: 'off' })).toBeNull()
    expect([
      isValidGraceDays(0),
      isValidGraceDays(30),
      isValidGraceDays(31),
      isValidGraceDays(1.5),
    ]).toEqual([true, true, false, false])
    expect(hasSecondFactor(['pwd'])).toBe(false)
    expect(hasSecondFactor(['pwd', 'otp'])).toBe(true)
  })
})

describe('invitations', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  const invitation: Invitation = {
    id: 'i-1',
    tenantId: 't-1',
    email: 'ana.souza@empresa.com.br',
    maskedEmail: maskEmail('ana.souza@empresa.com.br'),
    name: 'Ana Souza',
    roles: [{ module: 'financial', role: 'operator' }],
    tokenDigest: 'd-1',
    status: 'pending',
    invitedBy: 'u-1',
    createdAt: now,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    sends: 1,
    acceptedUserId: null,
    endedAt: null,
  }

  it('is usable for 72 hours, and a resend gives a new link and a new window', () => {
    expect(invitation.maskedEmail).toBe('a***@empresa.com.br')
    expect(isUsable(invitation, now)).toBe(true)
    const late = new Date(now.getTime() + INVITATION_TTL_MS)
    expect(statusAt(invitation, late)).toBe('expired')
    const again = resent(invitation, 'd-2', late)
    expect(isUsable(again, late)).toBe(true)
    expect(again.sends).toBe(2)
  })

  it('forgets the email once it ends', () => {
    const accepted = ended(invitation, 'accepted', now, 'user-9')
    expect(accepted).toMatchObject({ status: 'accepted', email: null, acceptedUserId: 'user-9' })
    expect(isUsable(accepted, now)).toBe(false)
  })
})

describe('session metadata', () => {
  it('labels a device and keeps only the network', () => {
    const chrome =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
    expect(deviceLabel(chrome)).toBe('Chrome on Linux')
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0')).toBe(
      'Firefox on Windows',
    )
    expect(deviceLabel('node')).toBe('Script')
    expect(deviceLabel(null)).toBe('Unknown device')
    expect(ipPrefix('192.168.10.42')).toBe('192.168.10.0/24')
    expect(ipPrefix('::ffff:10.0.0.7')).toBe('10.0.0.0/24')
    expect(ipPrefix('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48')
    expect(ipPrefix('garbage')).toBeNull()
  })
})
