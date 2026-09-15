import { identityContext, TEST_HASH, valid } from 'test/support/identity-context'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account } from '@/domain/entities/account'
import type {
  LegacyMembership,
  WorkspaceMembership,
} from '@/domain/repositories/accounts-repository'
import { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { ChoosePreferredLocaleUseCase } from './choose-preferred-locale'
import { DescribeCompanyUseCase, ReadWorkspaceUseCase } from './describe-company'

/** Only the two lookups the locale use case performs; everything else is unreachable. */
class MemoryAccounts extends AccountsRepository {
  constructor(
    readonly account: Account,
    readonly membership: WorkspaceMembership,
  ) {
    super()
  }
  async findById(accountId: string) {
    return accountId === this.membership.accountId ? this.account : null
  }
  async findAccountIdByMembership(tenantId: string, userId: string) {
    return tenantId === this.membership.tenantId && userId === this.membership.userId
      ? this.membership.accountId
      : null
  }
  async save(_account: Account) {}
  async findByEmail(_email: Email): Promise<Account | null> {
    throw new Error('Unused')
  }
  async findLegacyMemberships(_email: Email): Promise<readonly LegacyMembership[]> {
    throw new Error('Unused')
  }
  async provisionFromLegacy(): Promise<Account> {
    throw new Error('Unused')
  }
  async reconcileMemberships() {}
  async listWorkspaces(): Promise<readonly WorkspaceMembership[]> {
    throw new Error('Unused')
  }
  async findMembership(): Promise<WorkspaceMembership | null> {
    throw new Error('Unused')
  }
}

async function context() {
  const shared = await identityContext()
  const account = Account.create(
    {
      passwordHash: valid(PasswordHash.create(TEST_HASH)),
      createdAt: new Date('2026-09-10T12:00:00Z'),
    },
    new UniqueEntityID(),
  )
  const accounts = new MemoryAccounts(account, {
    accountId: account.id.toString(),
    tenantId: shared.tenantId,
    userId: shared.user.id.toString(),
    slug: 'example',
    name: 'Example Workspace',
  })
  return { ...shared, account, accounts }
}

const profile = {
  legalName: 'Horizon Comércio LTDA',
  taxId: '12.345.678/0001-95',
  baseCurrency: 'BRL',
  fiscalRegime: 'simples-nacional' as const,
}

describe('choosing a preferred locale', () => {
  it('stores the canonical tag on the global account, not on the membership', async () => {
    const c = await context()
    const useCase = new ChoosePreferredLocaleUseCase(c.accounts, c.unitOfWork, c.clock)

    const result = await useCase.execute({
      tenantId: c.tenantId,
      userId: c.user.id.toString(),
      locale: 'pt-br',
      actor: c.actor,
    })

    expect(valid(result).preferredLocale).toBe('pt-BR')
    expect(snapshotOf(c.account).preferredLocale).toBe('pt-BR')
  })

  it('records who changed it', async () => {
    const c = await context()
    const useCase = new ChoosePreferredLocaleUseCase(c.accounts, c.unitOfWork, c.clock)

    await useCase.execute({
      tenantId: c.tenantId,
      userId: c.user.id.toString(),
      locale: 'en',
      actor: c.actor,
    })

    expect(c.scope.auditRecords.at(-1)).toMatchObject({ action: 'account.locale.chosen' })
  })

  it('refuses a tag that is not a language', async () => {
    const c = await context()
    const useCase = new ChoosePreferredLocaleUseCase(c.accounts, c.unitOfWork, c.clock)

    const result = await useCase.execute({
      tenantId: c.tenantId,
      userId: c.user.id.toString(),
      locale: 'not a locale',
      actor: c.actor,
    })

    expect(result.isLeft()).toBe(true)
    expect(snapshotOf(c.account).preferredLocale).toBeNull()
  })

  it('refuses when the membership has no global account', async () => {
    const c = await context()
    const useCase = new ChoosePreferredLocaleUseCase(c.accounts, c.unitOfWork, c.clock)

    const result = await useCase.execute({
      tenantId: c.tenantId,
      userId: new UniqueEntityID().toString(),
      locale: 'en',
      actor: c.actor,
    })

    expect(result.isLeft()).toBe(true)
  })
})

describe('describing the company', () => {
  it('stores the profile and the timezone it operates in', async () => {
    const c = await context()
    const useCase = new DescribeCompanyUseCase(c.unitOfWork, c.clock)

    const result = await useCase.execute({
      tenantId: c.tenantId,
      company: profile,
      timezone: 'America/Manaus',
      actor: c.actor,
    })

    const snapshot = snapshotOf(valid(result).tenant)
    expect(snapshot.company?.legalName).toBe('Horizon Comércio LTDA')
    expect(snapshot.company?.taxId).toBe('12345678000195')
    expect(snapshot.timezone).toBe('America/Manaus')
  })

  it('reports BRL until a company says otherwise', async () => {
    const c = await context()
    expect(c.tenant.baseCurrency()).toBe('BRL')

    await new DescribeCompanyUseCase(c.unitOfWork, c.clock).execute({
      tenantId: c.tenantId,
      company: { ...profile, baseCurrency: 'USD' },
      timezone: 'America/Sao_Paulo',
      actor: c.actor,
    })

    const read = await new ReadWorkspaceUseCase(c.unitOfWork).execute({ tenantId: c.tenantId })
    expect(valid(read).tenant.baseCurrency()).toBe('USD')
  })

  it('refuses an unknown timezone and leaves the workspace untouched', async () => {
    const c = await context()

    const result = await new DescribeCompanyUseCase(c.unitOfWork, c.clock).execute({
      tenantId: c.tenantId,
      company: profile,
      timezone: 'Mars/Olympus',
      actor: c.actor,
    })

    expect(result.isLeft()).toBe(true)
    expect(snapshotOf(c.tenant).company).toBeNull()
  })

  it('records the change in the audit chain', async () => {
    const c = await context()

    await new DescribeCompanyUseCase(c.unitOfWork, c.clock).execute({
      tenantId: c.tenantId,
      company: profile,
      timezone: 'America/Sao_Paulo',
      actor: c.actor,
    })

    expect(c.scope.auditRecords.at(-1)).toMatchObject({ action: 'workspace.company.described' })
  })
})
