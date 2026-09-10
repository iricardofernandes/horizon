import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { SessionExpiredError } from '@/domain/errors/session-expired-error'
import { SessionReusedError } from '@/domain/errors/session-reused-error'
import { refreshSessionContext } from '../../../test/support/refresh-session-context'

describe('RefreshSessionUseCase', () => {
  it('rotates and persists the replacement, then returns it unchanged during grace', async () => {
    const ctx = await refreshSessionContext()
    const first = await ctx.sut.execute(ctx.request)
    expect(first.isRight()).toBe(true)
    if (first.isLeft()) throw first.value
    ctx.advance(500)
    const grace = await ctx.sut.execute(ctx.request)
    expect(grace.isRight()).toBe(true)
    if (grace.isLeft()) throw grace.value
    expect(grace.value.refreshToken).toBe(first.value.refreshToken)
    const stored = await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)
    expect(stored?.isCurrent(`digest:${first.value.refreshToken}`)).toBe(true)
    expect(ctx.audit.append).not.toHaveBeenCalled()
  })

  it('kills the family on replay outside grace and records the security event', async () => {
    const ctx = await refreshSessionContext()
    await ctx.sut.execute(ctx.request)
    ctx.advance(1001)
    const result = await ctx.sut.execute(ctx.request)
    expect(result.value).toBeInstanceOf(SessionReusedError)
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
    expect(ctx.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session.reuse-detected',
        subjectId: ctx.request.familyId,
      }),
    )
    const events = ctx.outbox.publish.mock.calls[0]?.[0]
    expect(events).toHaveLength(1)
    expect(events?.[0]?.tenantId).toBe(ctx.request.tenantId)
    expect(events?.[0]?.eventType).toBe('identity.session.reuse-detected')
    expect((await ctx.sut.execute(ctx.request)).value).toBeInstanceOf(SessionExpiredError)
  })

  it('keeps the family revoked when audit persistence fails', async () => {
    const ctx = await refreshSessionContext()
    await ctx.sut.execute(ctx.request)
    ctx.advance(1001)
    ctx.audit.append.mockRejectedValueOnce(new Error('Database unavailable'))
    await expect(ctx.sut.execute(ctx.request)).rejects.toThrow('Database unavailable')
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
    expect(ctx.outbox.publish).not.toHaveBeenCalled()
  })

  it('rejects an unknown token without revoking someone else’s family', async () => {
    const ctx = await refreshSessionContext()
    expect(
      (await ctx.sut.execute({ ...ctx.request, refreshToken: 'unknown' })).value,
    ).toBeInstanceOf(SessionExpiredError)
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).not.toBeNull()
    expect(ctx.signer.mint).not.toHaveBeenCalled()
  })

  it('cannot read or delete a family through another tenant', async () => {
    const ctx = await refreshSessionContext()
    const tenantId = new UniqueEntityID().toString()
    expect((await ctx.sut.execute({ ...ctx.request, tenantId })).value).toBeInstanceOf(
      SessionExpiredError,
    )
    await ctx.families.delete(tenantId, ctx.request.familyId)
    expect(await ctx.families.findAllForUser(tenantId, ctx.user.id.toString())).toEqual([])
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).not.toBeNull()
  })

  it('deletes an expired family without minting a token', async () => {
    const ctx = await refreshSessionContext()
    ctx.advance(10000)
    expect((await ctx.sut.execute(ctx.request)).value).toBeInstanceOf(SessionExpiredError)
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
    expect(ctx.signer.mint).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'missing'] as const)(
    'revokes the family when its user is %s',
    async (status) => {
      const ctx = await refreshSessionContext()
      if (status === 'disabled') ctx.user.disable(new Date())
      if (status === 'missing') ctx.removeUser()
      expect((await ctx.sut.execute(ctx.request)).value).toBeInstanceOf(SessionExpiredError)
      expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
      expect(ctx.signer.mint).not.toHaveBeenCalled()
    },
  )

  it('revokes a disabled user’s family during a grace retry', async () => {
    const ctx = await refreshSessionContext()
    await ctx.sut.execute(ctx.request)
    ctx.user.disable(new Date())
    ctx.advance(500)
    expect((await ctx.sut.execute(ctx.request)).value).toBeInstanceOf(SessionExpiredError)
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
    expect(ctx.signer.mint).toHaveBeenCalledTimes(1)
  })

  it('kills the family if its grace ciphertext cannot be opened', async () => {
    const ctx = await refreshSessionContext()
    await ctx.sut.execute(ctx.request)
    ctx.secretBox.open.mockReturnValueOnce(null)
    expect((await ctx.sut.execute(ctx.request)).value).toBeInstanceOf(SessionReusedError)
    expect(await ctx.families.findById(ctx.request.tenantId, ctx.request.familyId)).toBeNull()
  })
})
