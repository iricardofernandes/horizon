import { randomUUID } from 'node:crypto'
import { InMemoryCatalogUnitOfWork } from 'test/repositories/in-memory-catalog-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { AuditEntry } from '@/domain/audit/audit-entry'
import { CreateCatalogItemUseCase } from './use-cases/create-catalog-item'
import { CreateUnitUseCase } from './use-cases/create-unit'
import { DeactivateCatalogItemUseCase } from './use-cases/deactivate-catalog-item'
import { VerifyAuditChainUseCase } from './use-cases/verify-audit-chain'

const clock = { now: () => new Date('2026-01-01T00:00:00Z') }
const actor = { type: 'user', id: randomUUID() } as const

async function writes(tenantId: string) {
  const unitOfWork = new InMemoryCatalogUnitOfWork()
  const unit = await new CreateUnitUseCase(unitOfWork, clock).execute({
    actor,
    tenantId,
    code: 'UN',
    name: 'Unit',
    decimalPlaces: 0,
  })
  if (unit.isLeft()) throw unit.value
  const item = await new CreateCatalogItemUseCase(unitOfWork, clock).execute({
    actor,
    tenantId,
    kind: 'product',
    sku: 'COFFEE-1',
    name: 'Coffee',
    unitId: unit.value.unitId,
    requestId: 'req-1',
    traceId: 'a'.repeat(32),
  })
  if (item.isLeft()) throw item.value
  const deactivated = await new DeactivateCatalogItemUseCase(unitOfWork, clock).execute({
    actor,
    tenantId,
    itemId: item.value.itemId,
  })
  if (deactivated.isLeft()) throw deactivated.value
  return { unitOfWork, itemId: item.value.itemId }
}

describe('catalog audit chain', () => {
  it('records who changed what, with the correlation identifiers the caller supplied', async () => {
    const tenantId = randomUUID()
    const { unitOfWork, itemId } = await writes(tenantId)

    expect(unitOfWork.auditEntries.map((entry) => snapshotOf(entry).action)).toEqual([
      'catalog.unit.created',
      'catalog.item.created',
      'catalog.item.deactivated',
    ])
    const created = snapshotOf(unitOfWork.auditEntries[1])
    expect(created).toMatchObject({
      sequence: 2,
      tenantId,
      actorType: 'user',
      actorId: actor.id,
      subjectType: 'CatalogItem',
      subjectId: itemId,
      requestId: 'req-1',
      traceId: 'a'.repeat(32),
    })
    expect(created?.after).toEqual({
      kind: 'product',
      sku: 'COFFEE-1',
      name: 'Coffee',
      unitId: expect.any(String),
      ncm: null,
    })
    // The deactivation keeps both sides, which is what makes the entry evidence.
    const deactivated = snapshotOf(unitOfWork.auditEntries[2])
    expect(deactivated?.before).toEqual({ active: true })
    expect(deactivated?.after).toEqual({ active: false })
  })

  it('verifies an intact chain and names the first link that does not match', async () => {
    const tenantId = randomUUID()
    const { unitOfWork } = await writes(tenantId)
    const verify = new VerifyAuditChainUseCase(unitOfWork)

    const intact = await verify.execute({ tenantId })
    if (intact.isLeft()) throw intact.value
    expect(intact.value).toMatchObject({ intact: true, verifiedThrough: 3, brokenAt: null })

    // Rewriting an entry's action and leaving its stored hash in place is exactly the
    // edit the chain exists to expose.
    const forged = snapshotOf(unitOfWork.auditEntries[1])
    if (!forged) throw new Error('missing audit entry')
    unitOfWork.auditEntries[1] = AuditEntry.rehydrate(
      { ...forged, action: 'catalog.item.renamed' },
      new UniqueEntityID(forged.id),
    )

    const tampered = await verify.execute({ tenantId })
    if (tampered.isLeft()) throw tampered.value
    expect(tampered.value).toMatchObject({ intact: false, verifiedThrough: 1, brokenAt: 2 })
    expect(tampered.value.detail).toContain('entry 2')
  })

  it('walks a long chain in bounded batches and refuses an unbounded one', async () => {
    const tenantId = randomUUID()
    const { unitOfWork } = await writes(tenantId)
    const verify = new VerifyAuditChainUseCase(unitOfWork)

    const batched = await verify.execute({ tenantId, batchSize: 1 })
    if (batched.isLeft()) throw batched.value
    expect(batched.value).toMatchObject({ intact: true, verifiedThrough: 3 })
    expect((await verify.execute({ tenantId, batchSize: 0 })).isLeft()).toBe(true)
    expect((await verify.execute({ tenantId, batchSize: 5000 })).isLeft()).toBe(true)
  })

  it('keeps one tenant out of another tenant chain', async () => {
    const first = randomUUID()
    const second = randomUUID()
    const { unitOfWork } = await writes(first)
    await new CreateUnitUseCase(unitOfWork, clock).execute({
      actor,
      tenantId: second,
      code: 'KG',
      name: 'Kilogram',
      decimalPlaces: 3,
    })
    const verdict = await new VerifyAuditChainUseCase(unitOfWork).execute({ tenantId: second })
    if (verdict.isLeft()) throw verdict.value
    // A second tenant's first entry is sequence 1 against the genesis hash, not entry 4.
    expect(verdict.value).toMatchObject({ intact: true, verifiedThrough: 1 })
  })
})
