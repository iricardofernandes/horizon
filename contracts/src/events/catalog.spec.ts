import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { catalogItemCreated, catalogItemDeactivated, catalogPriceChanged } from './catalog'

describe('catalog event contracts', () => {
  it('accepts catalog item lifecycle payloads', () => {
    expect(
      catalogItemCreated.payload.safeParse({
        itemId: randomUUID(),
        kind: 'product',
        sku: 'COFFEE-1',
        name: 'Coffee',
        unitId: randomUUID(),
        ncm: '09012100',
      }).success,
    ).toBe(true)
    expect(catalogItemDeactivated.payload.safeParse({ itemId: randomUUID() }).success).toBe(true)
  })

  it('keeps money in integer minor units', () => {
    expect(
      catalogPriceChanged.payload.safeParse({
        priceListId: randomUUID(),
        itemId: randomUUID(),
        amount: '1250',
        currency: 'BRL',
      }).success,
    ).toBe(true)
    expect(
      catalogPriceChanged.payload.safeParse({
        priceListId: randomUUID(),
        itemId: randomUUID(),
        amount: '12.50',
        currency: 'BRL',
      }).success,
    ).toBe(false)
  })
})
