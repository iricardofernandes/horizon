import {
  type Challenge,
  type ChallengePurpose,
  FactorStore,
  InvitationStore,
  Mailer,
  type MailMessage,
  MfaChallenges,
  MfaLockout,
  MfaPolicies,
  type PasskeyCredential,
  Passkeys,
  type SessionMeta,
  SessionRegistry,
  type StoredFactor,
} from '@/application/ports/mfa'
import type { Invitation } from '@/domain/mfa/invitation'
import type { AuthMethod, MfaPolicy } from '@/domain/mfa/mfa-policy'
import { NO_MFA_POLICY } from '@/domain/mfa/mfa-policy'

export class MemoryFactors extends FactorStore {
  readonly factors: StoredFactor[] = []
  readonly codes = new Map<string, { digest: string; usedAt: Date | null }[]>()

  async list(accountId: string) {
    return this.factors.filter((factor) => factor.accountId === accountId)
  }
  async insert(factor: StoredFactor) {
    this.factors.push(factor)
  }
  private replace(id: string, change: Partial<StoredFactor>) {
    const index = this.factors.findIndex((factor) => factor.id === id)
    const current = this.factors[index]
    if (current) this.factors[index] = { ...current, ...change }
  }
  async confirm(_: string, factorId: string, step: number, now: Date) {
    const factor = this.factors.find((candidate) => candidate.id === factorId)
    if (!factor || factor.confirmedAt) return false
    this.replace(factorId, { confirmedAt: now, lastUsedStep: step, lastUsedAt: now })
    return true
  }
  async useTotpStep(_: string, factorId: string, step: number, now: Date) {
    const factor = this.factors.find((candidate) => candidate.id === factorId)
    if (!factor || (factor.lastUsedStep !== null && factor.lastUsedStep >= step)) return false
    this.replace(factorId, { lastUsedStep: step, lastUsedAt: now })
    return true
  }
  async usePasskey(_: string, factorId: string, signCount: number, now: Date) {
    this.replace(factorId, { signCount, lastUsedAt: now })
  }
  async remove(_: string, factorId: string) {
    const index = this.factors.findIndex((factor) => factor.id === factorId)
    if (index < 0) return false
    this.factors.splice(index, 1)
    return true
  }
  async replaceRecoveryCodes(accountId: string, digests: readonly string[]) {
    this.codes.set(
      accountId,
      digests.map((digest) => ({ digest, usedAt: null })),
    )
  }
  async useRecoveryCode(accountId: string, digest: string, now: Date) {
    const code = this.codes.get(accountId)?.find((held) => held.digest === digest && !held.usedAt)
    if (!code) return false
    code.usedAt = now
    return true
  }
  async remainingRecoveryCodes(accountId: string) {
    return (this.codes.get(accountId) ?? []).filter((held) => !held.usedAt).length
  }
}

export class MemoryLockout extends MfaLockout {
  readonly failures = new Map<string, number>()
  readonly locked = new Set<string>()
  async isLocked(accountId: string) {
    return this.locked.has(accountId)
  }
  async fail(accountId: string) {
    const failures = (this.failures.get(accountId) ?? 0) + 1
    this.failures.set(accountId, failures)
    if (failures >= 5) {
      this.locked.add(accountId)
      this.failures.delete(accountId)
    }
    return { locked: failures >= 5, failures }
  }
  async clear(accountId: string) {
    this.failures.delete(accountId)
  }
}

export class MemoryChallenges extends MfaChallenges {
  readonly held = new Map<string, Challenge>()
  readonly webauthn = new Map<string, string>()
  private next = 0
  async issue(accountId: string, purpose: ChallengePurpose) {
    const token = `challenge-${++this.next}`.padEnd(43, 'x')
    this.held.set(token, { accountId, purpose, webauthn: null })
    return { token, expiresAt: new Date(Date.now() + 300_000) }
  }
  async resolve(token: string) {
    return this.held.get(token) ?? null
  }
  async setWebauthn(token: string, challenge: string) {
    const current = this.held.get(token)
    if (current) this.held.set(token, { ...current, webauthn: challenge })
  }
  async consume(token: string) {
    const current = this.held.get(token) ?? null
    this.held.delete(token)
    return current
  }
  async rememberWebauthn(accountId: string, challenge: string) {
    this.webauthn.set(accountId, challenge)
  }
  async takeWebauthn(accountId: string) {
    const value = this.webauthn.get(accountId) ?? null
    this.webauthn.delete(accountId)
    return value
  }
}

/** A passkey whose "signature" is the challenge echoed back with the credential id. */
export class FakePasskeys extends Passkeys {
  async registrationOptions() {
    return { options: { challenge: 'register-challenge' }, challenge: 'register-challenge' }
  }
  async verifyRegistration(response: unknown, challenge: string) {
    const answer = response as { id?: string; challenge?: string }
    return answer.challenge === challenge && answer.id
      ? { id: answer.id, publicKey: 'public-key', signCount: 0, transports: ['internal'] }
      : null
  }
  async authenticationOptions(allow: readonly PasskeyCredential[]) {
    return {
      options: { allow: allow.map((credential) => credential.id) },
      challenge: 'login-challenge',
    }
  }
  async verifyAuthentication(
    response: unknown,
    challenge: string,
    credentials: readonly PasskeyCredential[],
  ) {
    const answer = response as { id?: string; challenge?: string }
    const credential = credentials.find((candidate) => candidate.id === answer.id)
    return credential && answer.challenge === challenge
      ? { id: credential.id, signCount: credential.signCount + 1 }
      : null
  }
}

export class MemoryMail extends Mailer {
  readonly sent: MailMessage[] = []
  failing = false
  async send(message: MailMessage) {
    if (this.failing) throw new Error('down')
    this.sent.push(message)
  }
}

export class MemoryInvitations extends InvitationStore {
  readonly held: Invitation[] = []
  async insert(invitation: Invitation) {
    this.held.push(invitation)
  }
  async find(tenantId: string, id: string) {
    return this.held.find((held) => held.tenantId === tenantId && held.id === id) ?? null
  }
  async findByDigest(digest: string) {
    return this.held.find((held) => held.tokenDigest === digest) ?? null
  }
  async list(tenantId: string) {
    return this.held.filter((held) => held.tenantId === tenantId)
  }
  async save(invitation: Invitation) {
    const index = this.held.findIndex((held) => held.id === invitation.id)
    this.held[index] = invitation
  }
  async claim(current: Invitation, next: Invitation) {
    const held = this.held.find((candidate) => candidate.id === current.id)
    if (held?.status !== 'pending' || held.tokenDigest !== current.tokenDigest) return false
    await this.save(next)
    return true
  }
}

export class MemoryPolicies extends MfaPolicies {
  readonly policies = new Map<string, MfaPolicy>()
  async find(tenantId: string) {
    return this.policies.get(tenantId) ?? NO_MFA_POLICY
  }
  async save(tenantId: string, policy: MfaPolicy) {
    this.policies.set(tenantId, policy)
  }
}

export class MemorySessions extends SessionRegistry {
  readonly metas = new Map<string, SessionMeta>()
  readonly tokens = new Map<string, { jti: string; expiresAt: Date }[]>()
  async open(meta: SessionMeta) {
    this.metas.set(meta.familyId, meta)
  }
  async find(_: string, familyId: string) {
    return this.metas.get(familyId) ?? null
  }
  async touch(_: string, familyId: string, now: Date) {
    const meta = this.metas.get(familyId)
    if (meta) this.metas.set(familyId, { ...meta, lastUsedAt: now })
  }
  async reauthenticate(_: string, familyId: string, amr: readonly AuthMethod[], authTime: Date) {
    const meta = this.metas.get(familyId)
    if (meta) this.metas.set(familyId, { ...meta, amr, authTime })
  }
  async recordToken(_: string, familyId: string, jti: string, expiresAt: Date) {
    this.tokens.set(familyId, [...(this.tokens.get(familyId) ?? []), { jti, expiresAt }])
  }
  async liveTokens(_: string, familyId: string, now: Date) {
    return (this.tokens.get(familyId) ?? []).filter((token) => token.expiresAt > now)
  }
  async forget(_: string, familyId: string) {
    this.metas.delete(familyId)
    this.tokens.delete(familyId)
  }
}
