import {
  FakePasskeys,
  MemoryChallenges,
  MemoryFactors,
  MemoryInvitations,
  MemoryLockout,
  MemoryMail,
  MemoryPolicies,
  MemorySessions,
} from 'test/repositories/in-memory-access'
import { identityContext, TEST_HASH, valid } from 'test/support/identity-context'
import { describe, expect, it } from 'vitest'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import { base32Decode, hotp, stepAt } from '@/domain/mfa/totp'
import {
  AccountsRepository,
  type LegacyMembership,
  type WorkspaceMembership,
} from '@/domain/repositories/accounts-repository'
import type { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { WorkspaceSelections } from '../../ports/workspace-selections'
import { RegisterUserUseCase } from '../register-user'
import { SelectWorkspaceUseCase } from '../select-workspace'
import { InvitationsUseCase } from './invitations'
import { MfaPolicyUseCase } from './mfa-policy'
import { SecondFactors } from './second-factors'
import { SessionsUseCase } from './sessions'
import { CompleteSignInUseCase, EnrollWithTokenUseCase } from './sign-in'
import { recentlyAuthenticated, STEP_UP_WINDOW_MS, StepUpUseCase } from './step-up'

class OneAccount extends AccountsRepository {
  memberships: WorkspaceMembership[] = []
  constructor(readonly account: Account | null) {
    super()
  }
  async findById(id: string) {
    return this.account?.id.toString() === id ? this.account : null
  }
  async findByEmail(_email: Email) {
    return this.account
  }
  async findLegacyMemberships(): Promise<readonly LegacyMembership[]> {
    return []
  }
  async provisionFromLegacy(): Promise<Account> {
    throw new Error('unused')
  }
  async reconcileMemberships() {}
  async listWorkspaces() {
    return this.memberships
  }
  async findMembership(accountId: string, tenantId: string) {
    return (
      this.memberships.find((m) => m.accountId === accountId && m.tenantId === tenantId) ?? null
    )
  }
  async findAccountIdByMembership(tenantId: string, userId: string) {
    return (
      this.memberships.find((m) => m.tenantId === tenantId && m.userId === userId)?.accountId ??
      null
    )
  }
  async save() {}
}

class GrantSelections extends WorkspaceSelections {
  readonly grants = new Map<string, { accountId: string; amr: readonly string[]; authTime: Date }>()
  private next = 0
  async issue(
    accountId: string,
    auth = { amr: ['pwd'] as readonly string[], authTime: new Date() },
  ) {
    const token = `selection-${++this.next}`.padEnd(43, 'y')
    this.grants.set(token, { accountId, ...auth })
    return { token, expiresAt: new Date() }
  }
  async resolve(token: string) {
    return this.grants.get(token)?.accountId ?? null
  }
  async consume(token: string) {
    return (await this.consumeGrant(token))?.accountId ?? null
  }
  override async consumeGrant(token: string) {
    const grant = this.grants.get(token)
    this.grants.delete(token)
    return grant ?? null
  }
}

async function setup() {
  const context = await identityContext()
  const account = Account.create(
    {
      passwordHash: valid(PasswordHash.create(TEST_HASH)),
      status: 'active',
      createdAt: context.clock.now(),
      updatedAt: context.clock.now(),
    },
    new UniqueEntityID(),
  )
  const accountId = account.id.toString()
  const accounts = new OneAccount(account)
  accounts.memberships.push({
    accountId,
    tenantId: context.tenantId,
    userId: context.user.id.toString(),
    slug: 'example',
    name: 'Example Workspace',
  })
  const factorStore = new MemoryFactors()
  const lockout = new MemoryLockout()
  const challenges = new MemoryChallenges()
  const registry = new MemorySessions()
  const factors = new SecondFactors(
    factorStore,
    lockout,
    new FakePasskeys(),
    { seal: (_key, plaintext) => `sealed:${plaintext}`, open: (_key, sealed) => sealed.slice(7) },
    { digest: (value) => `digest:${value}` },
    'seal-key-of-at-least-thirty-two-chars',
    context.clock,
  )
  const selections = new GrantSelections()
  const codeAt = (secret: string, offset = 0) =>
    hotp(base32Decode(secret), stepAt(context.clock.now()) + offset)
  async function enrolled() {
    const started = await factors.startTotp(accountId, 'ana@example.com')
    const confirmed = await factors.confirmTotp(accountId, started.factorId, codeAt(started.secret))
    context.advance(30_000)
    return { ...started, recoveryCodes: valid(confirmed).recoveryCodes ?? [] }
  }
  return {
    ...context,
    account,
    accountId,
    accounts,
    factorStore,
    lockout,
    challenges,
    registry,
    factors,
    selections,
    codeAt,
    enrolled,
  }
}

describe('second factors', () => {
  it('enrolls TOTP with ten recovery codes, and refuses a code used twice', async () => {
    const t = await setup()
    const { secret, recoveryCodes } = await t.enrolled()
    expect(recoveryCodes).toHaveLength(10)
    const code = t.codeAt(secret)
    expect(valid(await t.factors.verifyCode(t.accountId, 'totp', code))).toBe('otp')
    const replayed = await t.factors.verifyCode(t.accountId, 'totp', code)
    expect(replayed.isLeft() && replayed.value.name).toBe('InvalidCredentialsError')
    expect(await t.factors.methodsOf(t.accountId)).toEqual(['totp', 'recovery'])
  })

  it('uses a recovery code once, however it is typed', async () => {
    const t = await setup()
    const { recoveryCodes } = await t.enrolled()
    const [first = ''] = recoveryCodes
    expect(valid(await t.factors.verifyCode(t.accountId, 'recovery', first.toUpperCase()))).toBe(
      'rec',
    )
    const again = await t.factors.verifyCode(t.accountId, 'recovery', first)
    expect(again.isLeft()).toBe(true)
    expect((await t.factors.list(t.accountId)).recoveryCodesLeft).toBe(9)
  })

  it('locks after five wrong codes, even for the right one, and a right one clears the count', async () => {
    const t = await setup()
    const { secret } = await t.enrolled()
    for (let attempt = 0; attempt < 4; attempt += 1)
      await t.factors.verifyCode(t.accountId, 'totp', '000000')
    expect(valid(await t.factors.verifyCode(t.accountId, 'totp', t.codeAt(secret)))).toBe('otp')
    expect(t.lockout.failures.has(t.accountId)).toBe(false)
    for (let attempt = 0; attempt < 5; attempt += 1)
      await t.factors.verifyCode(t.accountId, 'recovery', 'zzzzz-zzzzz')
    t.advance(30_000)
    const locked = await t.factors.verifyCode(t.accountId, 'totp', t.codeAt(secret))
    expect(locked.isLeft() && locked.value.name).toBe('MfaLockedError')
  })

  it('refuses a wrong confirmation code, and removing the last factor drops the codes', async () => {
    const t = await setup()
    const started = await t.factors.startTotp(t.accountId, 'ana')
    const wrong = await t.factors.confirmTotp(t.accountId, started.factorId, '000000')
    expect(wrong.isLeft() && wrong.value.name).toBe('InvalidInputError')
    expect(await t.factors.hasActiveFactor(t.accountId)).toBe(false)
    const refused = await t.factors.regenerateRecoveryCodes(t.accountId)
    expect(refused.isLeft()).toBe(true)
    valid(await t.factors.confirmTotp(t.accountId, started.factorId, t.codeAt(started.secret)))
    expect(valid(await t.factors.regenerateRecoveryCodes(t.accountId))).toHaveLength(10)
    valid(await t.factors.remove(t.accountId, started.factorId))
    expect((await t.factors.list(t.accountId)).recoveryCodesLeft).toBe(0)
    expect((await t.factors.remove(t.accountId, started.factorId)).isLeft()).toBe(true)
  })

  it('registers a passkey and signs in with it', async () => {
    const t = await setup()
    const options = await t.factors.passkeyRegistrationOptions(t.accountId, 'ana')
    const registered = valid(
      await t.factors.registerPasskey(
        t.accountId,
        { id: 'cred-1', challenge: options.challenge },
        options.challenge,
        ' Laptop ',
      ),
    )
    expect(registered.recoveryCodes).toHaveLength(10)
    const login = await t.factors.passkeyOptions(t.accountId)
    expect(login?.options).toEqual({ allow: ['cred-1'] })
    const signed = await t.factors.verifyPasskey(
      t.accountId,
      { id: 'cred-1', challenge: 'login-challenge' },
      'login-challenge',
    )
    expect(valid(signed)).toBe('hwk')
    const forged = await t.factors.verifyPasskey(
      t.accountId,
      { id: 'cred-1', challenge: 'other' },
      'login-challenge',
    )
    expect(forged.isLeft()).toBe(true)
    const bad = await t.factors.registerPasskey(
      t.accountId,
      { id: 'x', challenge: 'no' },
      'yes',
      'x',
    )
    expect(bad.isLeft()).toBe(true)
  })
})

describe('signing in with a second factor', () => {
  it('spends the challenge once and grants a selection carrying the method', async () => {
    const t = await setup()
    const { secret } = await t.enrolled()
    const signIn = new CompleteSignInUseCase(
      t.challenges,
      t.factors,
      t.selections,
      t.accounts,
      t.clock,
    )
    const challenge = await t.challenges.issue(t.accountId, 'login')
    const wrong = await signIn.withCode(challenge.token, 'totp', '000000')
    expect(wrong.isLeft()).toBe(true)
    const choice = valid(await signIn.withCode(challenge.token, 'totp', t.codeAt(secret)))
    expect(choice.workspaces).toHaveLength(1)
    expect(t.selections.grants.get(choice.selectionToken)?.amr).toEqual(['pwd', 'otp'])
    expect((await signIn.withCode(challenge.token, 'totp', t.codeAt(secret, 1))).isLeft()).toBe(
      true,
    )
  })

  it('refuses an enrollment token for signing in, and a login challenge for enrolling', async () => {
    const t = await setup()
    const signIn = new CompleteSignInUseCase(
      t.challenges,
      t.factors,
      t.selections,
      t.accounts,
      t.clock,
    )
    const enrollment = await t.challenges.issue(t.accountId, 'enrollment')
    expect((await signIn.withCode(enrollment.token, 'totp', '123456')).isLeft()).toBe(true)
    const enroll = new EnrollWithTokenUseCase(t.challenges, t.factors)
    const login = await t.challenges.issue(t.accountId, 'login')
    expect((await enroll.start(login.token, 'x')).isLeft()).toBe(true)
    const started = valid(await enroll.start(enrollment.token, 'x'))
    const confirmed = await enroll.confirm(
      enrollment.token,
      started.factorId,
      t.codeAt(started.secret),
    )
    expect(valid(confirmed).recoveryCodes).toHaveLength(10)
    expect(t.challenges.held.has(enrollment.token)).toBe(false)
  })

  it('signs in with a passkey after asking for its options', async () => {
    const t = await setup()
    const options = await t.factors.passkeyRegistrationOptions(t.accountId, 'ana')
    valid(
      await t.factors.registerPasskey(
        t.accountId,
        { id: 'cred-9', challenge: options.challenge },
        options.challenge,
        'Key',
      ),
    )
    const signIn = new CompleteSignInUseCase(
      t.challenges,
      t.factors,
      t.selections,
      t.accounts,
      t.clock,
    )
    const challenge = await t.challenges.issue(t.accountId, 'login')
    expect((await signIn.withPasskey(challenge.token, {})).isLeft()).toBe(true)
    valid(await signIn.passkeyOptions(challenge.token))
    const choice = valid(
      await signIn.withPasskey(challenge.token, { id: 'cred-9', challenge: 'login-challenge' }),
    )
    expect(t.selections.grants.get(choice.selectionToken)?.amr).toEqual(['pwd', 'hwk'])
  })
})

describe('the workspace MFA policy at sign-in', () => {
  it('lets an uncovered person in, and a covered one only within the grace period', async () => {
    const t = await setup()
    const policies = new MemoryPolicies()
    const select = new SelectWorkspaceUseCase(
      t.unitOfWork,
      t.accounts,
      t.selections,
      t.sessions,
      t.clock,
      {
        policies,
        challenges: t.challenges,
      },
    )
    const choose = async () => {
      const selection = await t.selections.issue(t.accountId, {
        amr: ['pwd'],
        authTime: t.clock.now(),
      })
      return select.execute({
        selectionToken: selection.token,
        tenantId: t.tenantId,
        userAgent: 'node',
      })
    }
    expect((await choose()).isRight()).toBe(true)
    const policyUseCase = new MfaPolicyUseCase(t.unitOfWork, policies, t.clock)
    const bad = await policyUseCase.change(
      { tenantId: t.tenantId, actor: t.actor, requestId: null },
      { policy: 'some', graceDays: 1 },
    )
    expect(bad.isLeft()).toBe(true)
    valid(
      await policyUseCase.change(
        { tenantId: t.tenantId, actor: t.actor, requestId: null },
        { policy: 'admins', graceDays: 1 },
      ),
    )
    const inGrace = valid(await choose())
    expect(inGrace.enrollBy).toBeInstanceOf(Date)
    t.advance(86_400_000)
    const after = await choose()
    expect(after.isLeft() && after.value.name).toBe('MfaEnrollmentRequiredError')
    const withFactor = await t.selections.issue(t.accountId, {
      amr: ['pwd', 'otp'],
      authTime: t.clock.now(),
    })
    expect(
      (await select.execute({ selectionToken: withFactor.token, tenantId: t.tenantId })).isRight(),
    ).toBe(true)
    expect((await policyUseCase.find(t.tenantId)).policy).toBe('admins')
  })
})

describe('step-up and sessions', () => {
  it('steps up with the password and the second factor, and renews auth_time', async () => {
    const t = await setup()
    const { secret } = await t.enrolled()
    const stepUp = new StepUpUseCase(
      t.unitOfWork,
      t.accounts,
      t.hasher,
      t.factors,
      t.lockout,
      t.signer,
      t.registry,
      t.clock,
    )
    const base = {
      tenantId: t.tenantId,
      userId: t.user.id.toString(),
      sid: 'family-1',
      requestId: null,
    }
    expect((await stepUp.execute({ ...base, password: 'wrong' })).isLeft()).toBe(true)
    const needsCode = await stepUp.execute({ ...base, password: 'correct' })
    expect(needsCode.isLeft() && needsCode.value.name).toBe('StepUpRequiredError')
    const done = valid(
      await stepUp.execute({
        ...base,
        password: 'correct',
        method: 'totp',
        code: t.codeAt(secret),
      }),
    )
    expect(done.amr).toEqual(['pwd', 'otp'])
    expect(t.signer.mint).toHaveBeenLastCalledWith(expect.anything(), t.clock.now(), {
      sid: 'family-1',
      amr: ['pwd', 'otp'],
      authTime: t.clock.now(),
    })
    const noSession = await stepUp.execute({ ...base, sid: null, password: 'correct' })
    expect(noSession.isLeft()).toBe(true)
  })

  it('judges a token recent only within ten minutes, with a factor when there is one', () => {
    const now = new Date('2026-09-28T12:00:00Z')
    const recent = { amr: ['pwd'], authTime: new Date(now.getTime() - 60_000) }
    expect(recentlyAuthenticated(recent, false, now)).toBe(true)
    expect(recentlyAuthenticated(recent, true, now)).toBe(false)
    expect(recentlyAuthenticated({ ...recent, amr: ['pwd', 'otp'] }, true, now)).toBe(true)
    expect(
      recentlyAuthenticated(
        { amr: ['pwd'], authTime: new Date(now.getTime() - STEP_UP_WINDOW_MS - 1) },
        false,
        now,
      ),
    ).toBe(false)
    expect(recentlyAuthenticated({ amr: ['pwd'] }, false, now)).toBe(false)
  })

  it('lists sessions and ends them with every live access token they issued', async () => {
    const t = await setup()
    const sessionsIssuer = new (
      t.sessions.constructor as typeof import('../../services/session-issuer').SessionIssuer
    )(
      t.signer,
      t.families,
      { digest: (value) => `digest:${value}` },
      { seal: (_s, p) => p, open: (_s, c) => c },
      t.secrets,
      t.policy,
      t.registry,
    )
    const origin = {
      device: 'Chrome on Linux',
      ipPrefix: '10.0.0.0/24',
      amr: ['pwd'] as const,
      authTime: t.clock.now(),
    }
    const one = await sessionsIssuer.open(t.user, t.clock.now(), { ...origin, amr: ['pwd'] })
    const two = await sessionsIssuer.open(t.user, t.clock.now(), { ...origin, amr: ['pwd', 'otp'] })
    const sessions = new SessionsUseCase(t.unitOfWork, t.families, t.registry, t.denylist, t.clock)
    const userId = t.user.id.toString()
    const listed = await sessions.list(t.tenantId, userId, one.familyId)
    expect(listed.map((view) => [view.current, view.secondFactor]).sort()).toEqual([
      [false, true],
      [true, false],
    ])
    const ended = await sessions.endAll(t.tenantId, userId, one.familyId, t.actor, null)
    expect(ended.ended).toBe(1)
    expect(t.denylist.revoke).toHaveBeenCalledWith('access-id', expect.any(Date))
    expect(await t.families.findById(t.tenantId, two.familyId)).toBeNull()
    expect(
      (await sessions.end(t.tenantId, 'someone-else', one.familyId, t.actor, null)).isLeft(),
    ).toBe(true)
    valid(await sessions.end(t.tenantId, userId, one.familyId, t.actor, null))
    expect(await sessions.list(t.tenantId, userId, null)).toEqual([])
  })
})

describe('invitations', () => {
  async function inviting(options: { account?: Account | null } = {}) {
    const t = await setup()
    const store = new MemoryInvitations()
    const mail = new MemoryMail()
    const accounts = new OneAccount(options.account === undefined ? null : options.account)
    let next = 0
    const secrets = { ...t.secrets, token: () => `invitation-token-${++next}`.padEnd(43, 'z') }
    const invitations = new InvitationsUseCase(
      t.unitOfWork,
      store,
      mail,
      { digest: (value) => `digest:${value}` },
      secrets,
      new RegisterUserUseCase(t.unitOfWork, t.hasher, t.secrets, t.clock),
      accounts,
      t.hasher,
      t.clock,
      'http://web.test',
    )
    const context = {
      tenantId: t.tenantId,
      actor: { type: 'user' as const, id: t.user.id.toString() },
      requestId: null,
    }
    const tokenOf = (index: number) =>
      /token=([A-Za-z0-9_-]+)/.exec(mail.sent[index]?.text ?? '')?.[1] ?? ''
    return { ...t, store, mail, invitations, context, tokenOf }
  }

  it('invites by email with roles, and the link lets the person set a password once', async () => {
    const t = await inviting()
    const view = valid(
      await t.invitations.invite(t.context, {
        email: 'bia@example.com',
        name: 'Bia',
        roles: [{ module: 'financial', role: 'operator' }],
      }),
    )
    expect(view).toMatchObject({ email: 'b***@example.com', status: 'pending' })
    expect(t.mail.sent[0]?.text).toContain('http://web.test/accept-invitation?token=')
    const token = t.tokenOf(0)
    expect(valid(await t.invitations.lookup(token))).toMatchObject({
      workspace: 'Example Workspace',
      hasAccount: false,
    })
    const accepted = valid(
      await t.invitations.accept({ token, name: 'Bia Souza', password: 'correct-horse-battery' }),
    )
    expect(accepted.userId).toBeTruthy()
    expect(t.store.held[0]).toMatchObject({ status: 'accepted', email: null })
    const again = await t.invitations.accept({
      token,
      name: 'x',
      password: 'correct-horse-battery',
    })
    expect(again.isLeft() && again.value.name).toBe('InvitationUnusableError')
    const duplicate = await t.invitations.invite(t.context, {
      email: 'bia@example.com',
      name: 'Bia',
      roles: [],
    })
    expect(duplicate.isLeft()).toBe(true)
  })

  it('refuses an expired link, and a resend gives a new one that works', async () => {
    const t = await inviting()
    const view = valid(
      await t.invitations.invite(t.context, { email: 'caio@example.com', name: 'Caio', roles: [] }),
    )
    const first = t.tokenOf(0)
    t.advance(72 * 3_600_000)
    expect((await t.invitations.lookup(first)).isLeft()).toBe(true)
    expect((await t.invitations.list(t.tenantId))[0]?.status).toBe('expired')
    valid(await t.invitations.resend(t.context, view.id))
    expect((await t.invitations.lookup(first)).isLeft()).toBe(true)
    expect((await t.invitations.lookup(t.tokenOf(1))).isRight()).toBe(true)
    valid(await t.invitations.revoke(t.context, view.id))
    expect((await t.invitations.lookup(t.tokenOf(1))).isLeft()).toBe(true)
    expect((await t.invitations.revoke(t.context, view.id)).isLeft()).toBe(true)
    expect((await t.invitations.resend(t.context, 'missing')).isLeft()).toBe(true)
  })

  it('asks an existing account for its own password, and keeps an invitation whose mail failed', async () => {
    const existing = Account.create(
      {
        passwordHash: valid(PasswordHash.create(TEST_HASH)),
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      new UniqueEntityID(),
    )
    const t = await inviting({ account: existing })
    valid(
      await t.invitations.invite(t.context, { email: 'dora@example.com', name: 'Dora', roles: [] }),
    )
    const token = t.tokenOf(0)
    expect(valid(await t.invitations.lookup(token)).hasAccount).toBe(true)
    const wrong = await t.invitations.accept({ token, name: 'Dora', password: 'not-the-password' })
    expect(wrong.isLeft() && wrong.value.name).toBe('InvalidCredentialsError')
    t.mail.failing = true
    const kept = await t.invitations.invite(t.context, {
      email: 'eva@example.com',
      name: 'Eva',
      roles: [],
    })
    expect(kept.isLeft() && kept.value.name).toBe('MailUnavailableError')
    expect(t.store.held).toHaveLength(2)
  })
})
