import { randomUUID } from 'node:crypto'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import { MfaLockedError } from '@/domain/errors/mfa-errors'
import type { AuthMethod } from '@/domain/mfa/mfa-policy'
import { newRecoveryCodes, normalizedRecoveryCode } from '@/domain/mfa/recovery-codes'
import { matchingStep, newTotpSecret, otpauthUri, stepAt } from '@/domain/mfa/totp'
import type { SecretBox } from '@/domain/services/secret-box'
import type { TokenDigest } from '@/domain/services/token-digest'
import type { Clock } from '../../ports/clock'
import type {
  FactorStore,
  MfaLockout,
  PasskeyCredential,
  Passkeys,
  StoredFactor,
} from '../../ports/mfa'

export type CodeMethod = 'totp' | 'recovery'

export interface FactorView {
  readonly id: string
  readonly kind: 'totp' | 'passkey'
  readonly label: string
  readonly active: boolean
  readonly createdAt: Date
  readonly lastUsedAt: Date | null
}

const active = (factor: StoredFactor) => factor.confirmedAt !== null
const passkeysOf = (factors: readonly StoredFactor[]): PasskeyCredential[] =>
  factors
    .filter(
      (factor) =>
        factor.kind === 'passkey' && active(factor) && factor.credentialId && factor.publicKey,
    )
    .map((factor) => ({
      id: factor.credentialId ?? '',
      publicKey: factor.publicKey ?? '',
      signCount: factor.signCount,
      transports: factor.transports,
    }))

/**
 * An account's second factors (ADR 0061 §2): TOTP with recovery codes, and passkeys. Every
 * wrong answer counts toward a lockout, whatever the method; a right one clears it.
 */
export class SecondFactors {
  constructor(
    private readonly factors: FactorStore,
    private readonly lockout: MfaLockout,
    private readonly passkeys: Passkeys,
    private readonly secretBox: SecretBox,
    private readonly digest: TokenDigest,
    private readonly sealKey: string,
    private readonly clock: Clock,
    private readonly issuer = 'Horizon',
  ) {}

  async hasActiveFactor(accountId: string): Promise<boolean> {
    return (await this.factors.list(accountId)).some(active)
  }

  async methodsOf(accountId: string): Promise<('totp' | 'recovery' | 'passkey')[]> {
    const factors = (await this.factors.list(accountId)).filter(active)
    const methods: ('totp' | 'recovery' | 'passkey')[] = []
    if (factors.some((factor) => factor.kind === 'totp')) methods.push('totp')
    if (factors.some((factor) => factor.kind === 'passkey')) methods.push('passkey')
    if ((await this.factors.remainingRecoveryCodes(accountId)) > 0) methods.push('recovery')
    return methods
  }

  /** A TOTP or recovery code: the method it proved, or why not. */
  async verifyCode(
    accountId: string,
    method: CodeMethod,
    code: string,
  ): Promise<Either<InvalidCredentialsError | MfaLockedError, AuthMethod>> {
    if (await this.lockout.isLocked(accountId)) return left(new MfaLockedError())
    const now = this.clock.now()
    const proved =
      method === 'totp'
        ? await this.totp(accountId, code, now)
        : await this.recovery(accountId, code, now)
    return proved ? this.succeed(accountId, proved) : this.fail(accountId)
  }

  private async totp(accountId: string, code: string, now: Date): Promise<AuthMethod | null> {
    for (const factor of await this.factors.list(accountId)) {
      if (factor.kind !== 'totp' || !active(factor) || !factor.secretSealed) continue
      const secret = this.secretBox.open(this.sealKey, factor.secretSealed)
      if (!secret) continue
      const step = matchingStep(secret, code.trim(), now, factor.lastUsedStep)
      if (step !== null && (await this.factors.useTotpStep(accountId, factor.id, step, now)))
        return 'otp'
    }
    return null
  }

  private async recovery(accountId: string, code: string, now: Date): Promise<AuthMethod | null> {
    const normalized = normalizedRecoveryCode(code)
    if (!normalized) return null
    const used = await this.factors.useRecoveryCode(accountId, this.codeDigest(normalized), now)
    return used ? 'rec' : null
  }

  private async succeed(accountId: string, method: AuthMethod) {
    await this.lockout.clear(accountId)
    return right<InvalidCredentialsError | MfaLockedError, AuthMethod>(method)
  }

  private async fail(accountId: string) {
    const { locked } = await this.lockout.fail(accountId)
    return left<InvalidCredentialsError | MfaLockedError, AuthMethod>(
      locked ? new MfaLockedError() : new InvalidCredentialsError(),
    )
  }

  /** Options for signing in with a passkey; the challenge is remembered by the caller. */
  async passkeyOptions(accountId: string) {
    const credentials = passkeysOf(await this.factors.list(accountId))
    if (credentials.length === 0) return null
    return this.passkeys.authenticationOptions(credentials)
  }

  async verifyPasskey(
    accountId: string,
    response: unknown,
    challenge: string,
  ): Promise<Either<InvalidCredentialsError | MfaLockedError, AuthMethod>> {
    if (await this.lockout.isLocked(accountId)) return left(new MfaLockedError())
    const factors = await this.factors.list(accountId)
    const verified = await this.passkeys
      .verifyAuthentication(response, challenge, passkeysOf(factors))
      .catch(() => null)
    const factor = verified && factors.find((candidate) => candidate.credentialId === verified.id)
    if (!verified || !factor) return this.fail(accountId)
    await this.factors.usePasskey(accountId, factor.id, verified.signCount, this.clock.now())
    return this.succeed(accountId, 'hwk')
  }

  // --- enrollment ---------------------------------------------------------------

  async list(accountId: string): Promise<{ factors: FactorView[]; recoveryCodesLeft: number }> {
    const factors = await this.factors.list(accountId)
    return {
      factors: factors.map((factor) => ({
        id: factor.id,
        kind: factor.kind,
        label: factor.label,
        active: active(factor),
        createdAt: factor.createdAt,
        lastUsedAt: factor.lastUsedAt,
      })),
      recoveryCodesLeft: await this.factors.remainingRecoveryCodes(accountId),
    }
  }

  /** A pending TOTP factor: its secret and the URI the QR code carries. */
  async startTotp(accountId: string, accountLabel: string) {
    const secret = newTotpSecret()
    const factorId = randomUUID()
    await this.factors.insert({
      id: factorId,
      accountId,
      kind: 'totp',
      label: 'Authenticator app',
      secretSealed: this.secretBox.seal(this.sealKey, secret),
      credentialId: null,
      publicKey: null,
      signCount: 0,
      transports: [],
      confirmedAt: null,
      lastUsedStep: null,
      lastUsedAt: null,
      createdAt: this.clock.now(),
    })
    return { factorId, secret, otpauthUri: otpauthUri(secret, this.issuer, accountLabel) }
  }

  /** The first code proves the app holds the secret; the first factor brings recovery codes. */
  async confirmTotp(
    accountId: string,
    factorId: string,
    code: string,
  ): Promise<
    Either<ResourceNotFoundError | InvalidInputError, { recoveryCodes: string[] | null }>
  > {
    const factors = await this.factors.list(accountId)
    const factor = factors.find(
      (candidate) => candidate.id === factorId && candidate.kind === 'totp',
    )
    if (!factor?.secretSealed || active(factor)) return left(new ResourceNotFoundError('factor'))
    const secret = this.secretBox.open(this.sealKey, factor.secretSealed)
    const now = this.clock.now()
    const step = secret ? matchingStep(secret, code.trim(), now, null) : null
    if (step === null)
      return left(new InvalidInputError('code', 'the code does not match; try the next one'))
    const first = !factors.some(active)
    await this.factors.confirm(accountId, factorId, step ?? stepAt(now), now)
    return right({ recoveryCodes: first ? await this.newRecoveryCodes(accountId) : null })
  }

  async passkeyRegistrationOptions(accountId: string, userName: string) {
    const factors = await this.factors.list(accountId)
    return this.passkeys.registrationOptions({ accountId, userName, exclude: passkeysOf(factors) })
  }

  async registerPasskey(
    accountId: string,
    response: unknown,
    challenge: string,
    label: string,
  ): Promise<Either<InvalidInputError, { factorId: string; recoveryCodes: string[] | null }>> {
    const credential = await this.passkeys.verifyRegistration(response, challenge).catch(() => null)
    if (!credential)
      return left(new InvalidInputError('passkey', 'the passkey could not be verified'))
    const factors = await this.factors.list(accountId)
    const first = !factors.some(active)
    const now = this.clock.now()
    const factorId = randomUUID()
    await this.factors.insert({
      id: factorId,
      accountId,
      kind: 'passkey',
      label: label.trim().slice(0, 60) || 'Passkey',
      secretSealed: null,
      credentialId: credential.id,
      publicKey: credential.publicKey,
      signCount: credential.signCount,
      transports: credential.transports,
      confirmedAt: now,
      lastUsedStep: null,
      lastUsedAt: null,
      createdAt: now,
    })
    return right({ factorId, recoveryCodes: first ? await this.newRecoveryCodes(accountId) : null })
  }

  async remove(accountId: string, factorId: string): Promise<Either<ResourceNotFoundError, null>> {
    const removed = await this.factors.remove(accountId, factorId, this.clock.now())
    if (!removed) return left(new ResourceNotFoundError('factor'))
    if (!(await this.hasActiveFactor(accountId)))
      await this.factors.replaceRecoveryCodes(accountId, [], this.clock.now())
    return right(null)
  }

  /** Ten new codes, shown once; the old ones stop working. */
  async regenerateRecoveryCodes(accountId: string): Promise<Either<ConflictError, string[]>> {
    if (!(await this.hasActiveFactor(accountId)))
      return left(new ConflictError('recovery codes need a second factor first'))
    return right(await this.newRecoveryCodes(accountId))
  }

  private async newRecoveryCodes(accountId: string): Promise<string[]> {
    const codes = newRecoveryCodes()
    await this.factors.replaceRecoveryCodes(
      accountId,
      codes.map((code) => this.codeDigest(normalizedRecoveryCode(code) ?? code)),
      this.clock.now(),
    )
    return codes
  }

  private codeDigest(normalized: string): string {
    return this.digest.digest(`recovery-code:${normalized}`)
  }
}
