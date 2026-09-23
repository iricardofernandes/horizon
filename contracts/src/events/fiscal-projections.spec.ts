import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { catalogItemClassificationChanged } from './catalog'
import { companyFiscalProfileChanged } from './identity'
import { partyFiscalProfileChanged } from './parties'
import { salesFiscalOriginFrozen, salesFiscalOriginRecorded } from './sales'

describe('fiscal projection notices', () => {
  it('identifies exact revisions without transporting restricted profile fields', () => {
    const partyId = randomUUID()
    const tenantId = randomUUID()
    expect(
      partyFiscalProfileChanged.payload.safeParse({
        partyId,
        revision: 2,
        effectiveFrom: '2026-09-01',
      }).success,
    ).toBe(true)
    expect(
      companyFiscalProfileChanged.payload.safeParse({
        tenantId,
        revision: 1,
        effectiveFrom: '2026-09-01',
      }).success,
    ).toBe(true)
    expect(
      catalogItemClassificationChanged.payload.safeParse({
        itemId: randomUUID(),
        revision: 1,
        effectiveFrom: '2026-09-01',
        ncm: '09012100',
      }).success,
    ).toBe(true)
    expect(
      partyFiscalProfileChanged.payload.safeParse({
        partyId,
        revision: 2,
        effectiveFrom: '2026-09-01',
        taxId: '00000000E08G12',
      }).success,
    ).toBe(false)
  })

  it('keys a sales fiscal request by shipment and purpose', () => {
    const originId = randomUUID()
    const payload = {
      orderId: randomUUID(),
      originModule: 'sales',
      originDocumentType: 'shipment',
      originId,
      purpose: 'return',
      customerId: randomUUID(),
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          quantity: '1',
          description: 'Coffee',
          unitPrice: { amount: '100', currency: 'BRL' },
          lineTotal: { amount: '100', currency: 'BRL' },
        },
      ],
      total: { amount: '100', currency: 'BRL' },
    }
    expect(salesFiscalOriginRecorded.payload.safeParse(payload).success).toBe(true)
    expect(
      salesFiscalOriginRecorded.payload.safeParse({
        ...payload,
        originId: randomUUID(),
        purpose: 'other',
      }).success,
    ).toBe(false)
  })

  it('freezes a pre-dispatch shipment in a distinct event version', () => {
    const payload = {
      orderId: randomUUID(),
      orderVersion: 3,
      originModule: 'sales',
      originDocumentType: 'shipment',
      originId: randomUUID(),
      originRevision: 1,
      purpose: 'original',
      customerId: randomUUID(),
      warehouseId: randomUUID(),
      establishmentId: randomUUID(),
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          quantity: '1',
          description: 'Coffee',
          unitPrice: { amount: '100', currency: 'BRL' },
          lineTotal: { amount: '100', currency: 'BRL' },
        },
      ],
      total: { amount: '100', currency: 'BRL' },
      preDispatch: true,
    }
    expect(salesFiscalOriginFrozen.payload.safeParse(payload).success).toBe(true)
    expect(salesFiscalOriginRecorded.payload.safeParse(payload).success).toBe(false)
    expect(
      salesFiscalOriginFrozen.payload.safeParse({ ...payload, preDispatch: false }).success,
    ).toBe(false)
  })
})
