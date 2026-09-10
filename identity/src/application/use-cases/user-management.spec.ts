import { makeUser } from 'test/factories/make-user'
import { identityContext } from 'test/support/identity-context'
import { describe, expect, it } from 'vitest'
import { AssignRoleUseCase } from './assign-role'
import { CreateTenantUseCase } from './create-tenant'
import { ListUsersUseCase } from './list-users'
import { RegisterUserUseCase } from './register-user'

describe('tenant and user registration', () => {
  const signup = {
    name: 'New Workspace',
    slug: 'new-workspace',
    timezone: 'UTC',
    owner: { email: ' Owner@Example.com ', name: 'New Owner', password: 'correct' },
  }

  it('creates a workspace, its owner and the subject key together with audit and events', async () => {
    const c = await identityContext()
    const sut = new CreateTenantUseCase(
      c.unitOfWork,
      c.unitOfWork.directory,
      c.hasher,
      c.secrets,
      c.clock,
    )
    const result = await sut.execute(signup)
    expect(result.isRight()).toBe(true)
    if (result.isLeft()) throw result.value
    const { tenantId, ownerId } = result.value
    const scope = c.unitOfWork.scope(tenantId)
    expect(await c.unitOfWork.directory.resolve('new-workspace')).toBe(tenantId)
    expect(
      (await scope.users.findById(ownerId))?.holds({ module: 'identity', role: 'owner' }),
    ).toBe(true)
    expect(scope.keyRows.get(ownerId)?.material()).toBe('subject-key-material')
    expect(scope.writes).toEqual(['tenant', 'subject-key', 'user', 'audit'])
    expect(scope.auditRecords[0]).toMatchObject({ action: 'tenant.created', actor: c.actor })
    expect(scope.events.map((event) => event.eventType)).toEqual([
      'identity.tenant.created',
      'identity.user.registered',
    ])
    expect(scope.events.map((event) => event.payloadOf())).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ email: expect.anything() })]),
    )
  })

  it.each([
    { name: '' },
    { slug: '?' },
    { timezone: 'Unknown/Zone' },
    { owner: { ...signup.owner, email: 'invalid' } },
    { owner: { ...signup.owner, name: '' } },
  ])('rejects invalid signup before expensive hashing: %j', async (patch) => {
    const c = await identityContext()
    const sut = new CreateTenantUseCase(
      c.unitOfWork,
      c.unitOfWork.directory,
      c.hasher,
      c.secrets,
      c.clock,
    )
    expect((await sut.execute({ ...signup, ...patch })).isLeft()).toBe(true)
    expect(c.hasher.hash).not.toHaveBeenCalled()
  })

  it('rejects an occupied handle and malformed hash without registering the workspace', async () => {
    const c = await identityContext()
    const sut = new CreateTenantUseCase(
      c.unitOfWork,
      c.unitOfWork.directory,
      c.hasher,
      c.secrets,
      c.clock,
    )
    expect((await sut.execute({ ...signup, slug: 'example' })).isLeft()).toBe(true)
    c.hasher.hash.mockResolvedValue('broken')
    expect((await sut.execute(signup)).isLeft()).toBe(true)
    expect(await c.unitOfWork.directory.resolve(signup.slug)).toBeNull()
  })

  it('registers a user with a key before personal data and refuses a duplicate normalized email', async () => {
    const c = await identityContext()
    const sut = new RegisterUserUseCase(c.unitOfWork, c.hasher, c.secrets, c.clock)
    const request = {
      tenantId: c.tenantId,
      email: ' New@Example.com ',
      name: 'New Person',
      password: 'correct',
      roles: [],
      actor: c.actor,
    }
    const result = await sut.execute(request)
    if (result.isLeft()) throw result.value
    expect(c.scope.keyRows.get(result.value.userId)?.isErased()).toBe(false)
    expect(c.scope.writes.slice(-3)).toEqual(['subject-key', 'user', 'audit'])
    expect(c.scope.auditRecords.at(-1)).toMatchObject({
      action: 'user.registered',
      after: { email: 'new@example.com' },
      dataSubjectId: result.value.userId,
    })
    expect((await sut.execute({ ...request, email: 'new@example.com' })).isLeft()).toBe(true)
    const otherTenant = c.unitOfWork.scope('other-tenant')
    expect((await sut.execute({ ...request, tenantId: otherTenant.tenantId })).isRight()).toBe(true)
  })

  it.each([{ email: '' }, { name: '' }, { malformedHash: true }])(
    'rejects malformed registration: %j',
    async (patch) => {
      const c = await identityContext()
      if ('malformedHash' in patch) c.hasher.hash.mockResolvedValue('broken')
      const sut = new RegisterUserUseCase(c.unitOfWork, c.hasher, c.secrets, c.clock)
      const result = await sut.execute({
        tenantId: c.tenantId,
        email: 'new@example.com',
        name: 'New Person',
        password: 'correct',
        roles: [],
        actor: c.actor,
        ...patch,
      })
      expect(result.isLeft()).toBe(true)
      expect(c.scope.userRows.size).toBe(1)
      expect(c.scope.auditRecords).toHaveLength(0)
    },
  )
})

describe('role assignments and listing', () => {
  it('grants and revokes opaque roles with complete before/after audit records', async () => {
    const c = await identityContext()
    const sut = new AssignRoleUseCase(c.unitOfWork, c.clock)
    const assignment = { module: 'catalog', role: 'editor' }
    const request = {
      tenantId: c.tenantId,
      userId: c.user.id.toString(),
      actor: c.actor,
      assignment,
      requestId: 'request',
    }
    expect((await sut.execute({ ...request, operation: 'grant' })).isRight()).toBe(true)
    expect(c.user.holds(assignment)).toBe(true)
    expect((await sut.execute({ ...request, operation: 'grant' })).isLeft()).toBe(true)
    expect((await sut.execute({ ...request, operation: 'revoke' })).isRight()).toBe(true)
    expect(c.user.holds(assignment)).toBe(false)
    expect((await sut.execute({ ...request, operation: 'revoke' })).isLeft()).toBe(true)
    expect(c.scope.auditRecords).toHaveLength(2)
    expect(c.scope.auditRecords[0]).toMatchObject({
      action: 'user.role.granted',
      requestId: 'request',
      after: { roles: expect.arrayContaining([assignment]) },
    })
    expect(
      (await sut.execute({ ...request, operation: 'grant', tenantId: 'another-tenant' })).isLeft(),
    ).toBe(true)
  })

  it('paginates only the selected tenant and bounds the requested page size', async () => {
    const c = await identityContext()
    const another = makeUser({ tenantId: c.tenantId })
    await c.scope.users.create(another)
    const sut = new ListUsersUseCase(c.unitOfWork)
    const first = await sut.execute({ tenantId: c.tenantId, limit: 0 })
    expect(first.value).toMatchObject({
      items: [c.user],
      hasMore: true,
      nextCursor: c.user.id.toString(),
    })
    const second = await sut.execute({ tenantId: c.tenantId, cursor: c.user.id.toString() })
    expect(second.value).toMatchObject({ items: [another], hasMore: false })
    expect((await sut.execute({ tenantId: 'other', limit: 1000 })).value.items).toEqual([])
    await expect(c.unitOfWork.scope('other').users.create(c.user)).rejects.toThrow('Cross-tenant')
  })
})
