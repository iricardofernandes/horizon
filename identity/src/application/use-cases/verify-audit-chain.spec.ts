import type { TenantScope, UnitOfWork } from '@/application/ports/unit-of-work'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import type { AuditEntry } from '@/domain/audit/audit-entry'
import { makeAuditEntry, tamperAuditEntry } from '../../../test/factories/make-audit-entry'
import { VerifyAuditChainUseCase } from './verify-audit-chain'

function unused(): never {
  throw new Error('Unexpected repository operation')
}

function setup() {
  const tenantId = new UniqueEntityID().toString()
  const entries: AuditEntry[] = []
  const walk = vi.fn(async (cursor: number, limit: number) =>
    entries.filter((entry) => entry.sequenceNumber() > cursor).slice(0, limit),
  )
  const scope: TenantScope = {
    tenantId,
    get tenants() {
      return unused()
    },
    get users() {
      return unused()
    },
    get apiKeys() {
      return unused()
    },
    get dataSubjectKeys() {
      return unused()
    },
    get outbox() {
      return unused()
    },
    audit: { walk, append: unused, lastSequence: unused },
  }
  const unitOfWork: UnitOfWork = {
    async inTenant(id, work) {
      expect(id).toBe(tenantId)
      return work(scope)
    },
  }
  const sut = new VerifyAuditChainUseCase(unitOfWork)
  const append = () =>
    entries.push(
      makeAuditEntry({ tenantId, sequence: entries.length + 1 }, entries.at(-1)?.hashValue()),
    )
  return { sut, tenantId, entries, append, walk }
}

describe('VerifyAuditChainUseCase', () => {
  it('accepts an empty chain', async () => {
    const ctx = setup()
    const result = await ctx.sut.execute({ tenantId: ctx.tenantId })
    expect(result.value).toMatchObject({ intact: true, verifiedThrough: 0, brokenAt: null })
  })

  it('verifies across page boundaries with a bounded batch', async () => {
    const ctx = setup()
    for (let index = 0; index < 5; index++) ctx.append()
    const result = await ctx.sut.execute({ tenantId: ctx.tenantId, batchSize: 2 })
    expect(result.value).toMatchObject({ intact: true, verifiedThrough: 5, brokenAt: null })
    expect(ctx.walk.mock.calls).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ])
  })

  it('names the first tampered row and stops reading', async () => {
    const ctx = setup()
    for (let index = 0; index < 5; index++) ctx.append()
    const entry = ctx.entries[2]
    if (!entry) throw new Error('Missing fixture')
    ctx.entries[2] = tamperAuditEntry(entry, { action: 'forged' })
    const result = await ctx.sut.execute({ tenantId: ctx.tenantId, batchSize: 2 })
    expect(result.value).toMatchObject({ intact: false, verifiedThrough: 2, brokenAt: 3 })
    expect(ctx.walk).toHaveBeenCalledTimes(2)
  })

  it('detects a missing interior row through its successor', async () => {
    const ctx = setup()
    for (let index = 0; index < 3; index++) ctx.append()
    ctx.entries.splice(1, 1)
    const result = await ctx.sut.execute({ tenantId: ctx.tenantId })
    expect(result.value).toMatchObject({ intact: false, verifiedThrough: 1, brokenAt: 3 })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])(
    'rejects invalid batch size %s before reading',
    async (batchSize) => {
      const ctx = setup()
      const result = await ctx.sut.execute({ tenantId: ctx.tenantId, batchSize })
      expect(result.value).toBeInstanceOf(InvalidInputError)
      expect(ctx.walk).not.toHaveBeenCalled()
    },
  )
})
