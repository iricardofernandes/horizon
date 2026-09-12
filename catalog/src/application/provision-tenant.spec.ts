import { randomUUID } from 'node:crypto'
import { InMemoryCatalogUnitOfWork } from 'test/repositories/in-memory-catalog-unit-of-work'
import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import { ProvisionTenantCatalogUseCase } from './use-cases/provision-tenant-catalog'

const clock = { now: () => new Date('2026-01-01T00:00:00Z') }

function event(eventId = randomUUID()) {
  return { sourceModule: 'identity', eventId, eventType: 'identity.tenant.created' }
}

function useCase(unitOfWork: InMemoryCatalogUnitOfWork) {
  return new ProvisionTenantCatalogUseCase(unitOfWork, clock, { priceListCurrency: 'BRL' })
}

describe('provisioning a tenant catalogue', () => {
  it('creates the default units and an empty base price list', async () => {
    const tenantId = randomUUID()
    const unitOfWork = new InMemoryCatalogUnitOfWork()

    const result = await useCase(unitOfWork).execute({ tenantId, event: event() })
    if (result.isLeft()) throw result.value
    expect(result.value).toEqual({ provisioned: true })
    expect(unitOfWork.provisionedTenants.has(tenantId)).toBe(true)
    expect(unitOfWork.units.map((unit) => snapshotOf(unit).code)).toEqual(['UN', 'KG', 'L', 'H'])
    expect(snapshotOf(unitOfWork.priceLists[0])).toMatchObject({
      name: 'Base',
      currency: 'BRL',
      prices: [],
    })
    // Nobody performed this; the entries say so rather than naming an arbitrary user.
    expect(unitOfWork.auditEntries).toHaveLength(5)
    expect(snapshotOf(unitOfWork.auditEntries[0])).toMatchObject({
      actorType: 'system',
      actorId: null,
      action: 'catalog.unit.created',
    })
  })

  it('does nothing at all when the same event is delivered again', async () => {
    const tenantId = randomUUID()
    const unitOfWork = new InMemoryCatalogUnitOfWork()
    const delivery = event()

    await useCase(unitOfWork).execute({ tenantId, event: delivery })
    const redelivered = await useCase(unitOfWork).execute({ tenantId, event: delivery })
    if (redelivered.isLeft()) throw redelivered.value

    expect(redelivered.value).toEqual({ provisioned: false })
    expect(unitOfWork.units).toHaveLength(4)
    expect(unitOfWork.auditEntries).toHaveLength(5)
  })

  it('adds nothing twice when a different event provisions the same tenant again', async () => {
    const tenantId = randomUUID()
    const unitOfWork = new InMemoryCatalogUnitOfWork()

    await useCase(unitOfWork).execute({ tenantId, event: event() })
    // The inbox cannot help here: this is a second, genuinely different event. Every step
    // checks for what it is about to create, so an operator repeating provisioning by
    // hand does not end up with two "Base" price lists.
    const again = await useCase(unitOfWork).execute({ tenantId, event: event() })
    if (again.isLeft()) throw again.value

    expect(again.value).toEqual({ provisioned: true })
    expect(unitOfWork.units).toHaveLength(4)
    expect(unitOfWork.priceLists).toHaveLength(1)
  })

  it('refuses a configured currency that is not an ISO code', async () => {
    const unitOfWork = new InMemoryCatalogUnitOfWork()
    const misconfigured = new ProvisionTenantCatalogUseCase(unitOfWork, clock, {
      priceListCurrency: 'reais',
    })
    expect((await misconfigured.execute({ tenantId: randomUUID(), event: event() })).isLeft()).toBe(
      true,
    )
    expect(unitOfWork.units).toHaveLength(0)
  })
})
