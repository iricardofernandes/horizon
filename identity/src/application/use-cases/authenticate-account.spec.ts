import { makeUser } from 'test/factories/make-user'
import { identityContext, TEST_HASH, valid } from 'test/support/identity-context'
import { describe, expect, it, vi } from 'vitest'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import { AccountDisabledError } from '@/domain/errors/account-disabled-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import type {
  LegacyMembership,
  WorkspaceMembership,
} from '@/domain/repositories/accounts-repository'
import { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { penaltyMs } from '../ports/password-attempts'
import { WorkspaceSelections } from '../ports/workspace-selections'
import { AuthenticateAccountUseCase } from './authenticate-account'
import {
  BeginWorkspaceSwitchUseCase,
  ListSelectableWorkspacesUseCase,
  SelectWorkspaceUseCase,
} from './select-workspace'

class MemoryAccounts extends AccountsRepository {
  account: Account | null = null
  linked: WorkspaceMembership[] = []

  constructor(readonly legacy: readonly LegacyMembership[]) {
    super()
  }

  async findById(accountId: string) {
    return this.account?.id.toString() === accountId ? this.account : null
  }

  async findByEmail(_email: Email) {
    return this.account
  }

  async findLegacyMemberships(_email: Email) {
    return this.legacy
  }

  async provisionFromLegacy(_email: Email, _membership: LegacyMembership) {
    const now = new Date('2026-09-10T12:00:00Z')
    this.account = Account.create(
      {
        passwordHash: valid(PasswordHash.create(TEST_HASH)),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      new UniqueEntityID(),
    )
    return this.account
  }

  async reconcileMemberships(accountId: string, memberships: readonly LegacyMembership[]) {
    this.linked = memberships.map((membership) => ({
      accountId,
      tenantId: membership.tenantId,
      userId: membership.user.id.toString(),
      slug: membership.slug,
      name: membership.name,
    }))
  }

  async listWorkspaces(accountId: string) {
    return this.linked.filter((membership) => membership.accountId === accountId)
  }

  async findMembership(accountId: string, tenantId: string) {
    return (
      this.linked.find(
        (membership) => membership.accountId === accountId && membership.tenantId === tenantId,
      ) ?? null
    )
  }

  async findAccountIdByMembership(tenantId: string, userId: string) {
    return (
      this.linked.find(
        (membership) => membership.tenantId === tenantId && membership.userId === userId,
      )?.accountId ?? null
    )
  }

  async save(account: Account) {
    this.account = account
  }
}

class MemorySelections extends WorkspaceSelections {
  readonly values = new Map<string, string>()
  readonly token = 's'.repeat(43)

  async issue(accountId: string) {
    this.values.set(this.token, accountId)
    return { token: this.token, expiresAt: new Date('2026-09-10T12:05:00Z') }
  }

  async resolve(token: string) {
    return this.values.get(token) ?? null
  }

  async consume(token: string) {
    const accountId = this.values.get(token) ?? null
    this.values.delete(token)
    return accountId
  }
}

describe('account-first workspace authentication', () => {
  it('does not mint a tenant session until an allowed workspace is selected', async () => {
    const c = await identityContext()
    const accounts = new MemoryAccounts([
      {
        tenantId: c.tenantId,
        slug: 'example',
        name: 'Example Workspace',
        user: c.user,
      },
    ])
    const selections = new MemorySelections()
    const authenticate = new AuthenticateAccountUseCase(
      accounts,
      c.hasher,
      selections,
      c.policy,
      c.clock,
    )

    const login = valid(
      await authenticate.execute({ email: 'person@example.com', password: 'correct' }),
    )
    expect(login.workspaces).toEqual([
      { tenantId: c.tenantId, slug: 'example', name: 'Example Workspace' },
    ])
    expect(c.signer.mint).not.toHaveBeenCalled()

    const listed = valid(
      await new ListSelectableWorkspacesUseCase(accounts, selections).execute(login.selectionToken),
    )
    expect(listed).toEqual(login.workspaces)

    const select = new SelectWorkspaceUseCase(
      c.unitOfWork,
      accounts,
      selections,
      c.sessions,
      c.clock,
    )
    expect(
      valid(
        await select.execute({
          selectionToken: login.selectionToken,
          tenantId: c.tenantId,
        }),
      ).accessToken,
    ).toBe('access-token')
    expect(c.signer.mint).toHaveBeenCalledOnce()
    expect(
      (
        await select.execute({
          selectionToken: login.selectionToken,
          tenantId: c.tenantId,
        })
      ).isLeft(),
    ).toBe(true)
  })

  it('links only same-email legacy memberships that prove the supplied password', async () => {
    const c = await identityContext()
    const secondHash = valid(PasswordHash.create('$argon2id$v=19$m=19456,t=2,p=1$c2FsdDI$aGFzaDI'))
    const otherUser = makeUser({ passwordHash: secondHash })
    const accounts = new MemoryAccounts([
      { tenantId: c.tenantId, slug: 'example', name: 'Example Workspace', user: c.user },
      {
        tenantId: otherUser.claims().tenantId,
        slug: 'unrelated',
        name: 'Unrelated Workspace',
        user: otherUser,
      },
    ])
    const hasher = {
      ...c.hasher,
      verify: vi.fn(
        async (encoded: string, plaintext: string) =>
          plaintext === (encoded === secondHash.encoded ? 'different' : 'correct'),
      ),
    }

    const result = valid(
      await new AuthenticateAccountUseCase(
        accounts,
        hasher,
        new MemorySelections(),
        c.policy,
        c.clock,
      ).execute({ email: 'person@example.com', password: 'correct' }),
    )

    expect(result.workspaces.map(({ slug }) => slug)).toEqual(['example'])
  })

  it('issues a fresh selection when an authenticated member switches workspace', async () => {
    const c = await identityContext()
    const accounts = new MemoryAccounts([])
    accounts.linked = [
      {
        accountId: 'account-1',
        tenantId: c.tenantId,
        userId: c.user.id.toString(),
        slug: 'example',
        name: 'Example Workspace',
      },
    ]
    const selections = new MemorySelections()

    const result = valid(
      await new BeginWorkspaceSwitchUseCase(accounts, selections).execute({
        tenantId: c.tenantId,
        userId: c.user.id.toString(),
      }),
    )

    expect(result.selectionToken).toBe(selections.token)
    expect(result.workspaces).toEqual([
      { tenantId: c.tenantId, slug: 'example', name: 'Example Workspace' },
    ])
  })

  it('performs a dummy verification when no account or legacy membership exists', async () => {
    const c = await identityContext()
    const result = await new AuthenticateAccountUseCase(
      new MemoryAccounts([]),
      c.hasher,
      new MemorySelections(),
      c.policy,
      c.clock,
    ).execute({ email: 'missing@example.com', password: 'incorrect' })

    expect(result.isLeft()).toBe(true)
    expect(c.hasher.verifyDummy).toHaveBeenCalledOnce()
  })

  it('makes each wrong password wait longer, by account name, and clears the count on the right one (Phase 92)', async () => {
    const c = await identityContext()
    const accounts = new MemoryAccounts([
      { tenantId: c.tenantId, slug: 'example', name: 'Example Workspace', user: c.user },
    ])
    const counts = new Map<string, number>()
    const waited: number[] = []
    const authenticate = new AuthenticateAccountUseCase(
      accounts,
      c.hasher,
      new MemorySelections(),
      c.policy,
      c.clock,
      undefined,
      {
        attempts: {
          failures: async (email) => counts.get(email) ?? 0,
          failed: async (email) => void counts.set(email, (counts.get(email) ?? 0) + 1),
          cleared: async (email) => void counts.delete(email),
        },
        sleep: async (milliseconds) => void waited.push(milliseconds),
      },
    )
    for (let attempt = 0; attempt < 6; attempt += 1)
      expect(
        (await authenticate.execute({ email: 'person@example.com', password: 'wrong' })).isLeft(),
      ).toBe(true)
    // Three free mistakes, then half a second, one, two.
    expect(waited).toEqual([500, 1000, 2000])
    // An account that does not exist is counted the same way, so the wait reveals nothing.
    for (let attempt = 0; attempt < 4; attempt += 1)
      await authenticate.execute({ email: 'nobody@example.com', password: 'wrong' })
    expect(waited).toEqual([500, 1000, 2000, 500])
    valid(await authenticate.execute({ email: 'person@example.com', password: 'correct' }))
    expect(counts.has('person@example.com')).toBe(false)
    expect(penaltyMs(40)).toBe(8000)
  })

  it('tells a disabled account so only when nothing is left to prove (Phase 92)', async () => {
    const c = await identityContext()
    const accounts = new MemoryAccounts([])
    accounts.account = Account.create({
      passwordHash: valid(PasswordHash.create(TEST_HASH)),
      status: 'disabled',
    })
    const withFactor = (active: boolean) =>
      new AuthenticateAccountUseCase(
        accounts,
        c.hasher,
        new MemorySelections(),
        c.policy,
        c.clock,
        {
          methodsOf: async () => ['totp'],
          hasActiveFactor: async () => active,
          issueChallenge: async () => ({ token: 't', expiresAt: new Date() }),
        },
      ).execute({ email: 'person@example.com', password: 'correct' })
    // With a second factor unproved, the right password alone learns nothing.
    const guarded = await withFactor(true)
    expect(guarded.isLeft() && guarded.value).toBeInstanceOf(InvalidCredentialsError)
    const plain = await withFactor(false)
    expect(plain.isLeft() && plain.value).toBeInstanceOf(AccountDisabledError)
  })
})
