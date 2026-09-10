import { randomUUID } from 'node:crypto'
import { CatalogItem } from './entities/catalog-item'
import { PriceList } from './entities/price-list'
import { UnitOfMeasure } from './entities/unit-of-measure'
import {
  CatalogName,
  Currency,
  Money,
  NcmCode,
  Sku,
  UnitCode,
} from './value-objects/catalog-values'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

describe('catalog domain', () => {
  it('normalizes catalog values and validates Brazilian NCM codes', () => {
    expect(unwrap(Sku.create(' abc-1 ')).value).toBe('ABC-1')
    expect(unwrap(UnitCode.create('un')).value).toBe('UN')
    expect(unwrap(NcmCode.create('1234.56.78')).value).toBe('12345678')
    expect(NcmCode.create('123').isLeft()).toBe(true)
    expect(CatalogName.create('   ').isLeft()).toBe(true)
    expect(UnitCode.create('TOO-LONG').isLeft()).toBe(true)
    expect(Currency.create('12').isLeft()).toBe(true)
  })

  it('deactivates a unit only once', () => {
    const unit = UnitOfMeasure.create({
      tenantId: randomUUID(),
      code: unwrap(UnitCode.create('KG')),
      name: unwrap(CatalogName.create('Kilogram')),
      decimalPlaces: 3,
    })
    expect(unit.isActive()).toBe(true)
    expect(unit.deactivate(new Date()).isRight()).toBe(true)
    expect(unit.deactivate(new Date()).isLeft()).toBe(true)
  })

  it('records creation and deactivation exactly once', () => {
    const item = CatalogItem.register({
      tenantId: randomUUID(),
      kind: 'product',
      sku: unwrap(Sku.create('SKU-1')),
      name: unwrap(CatalogName.create('Coffee')),
      unitId: randomUUID(),
      ncm: unwrap(NcmCode.create('09012100')),
      now: new Date('2026-01-01T00:00:00Z'),
    })
    expect(item.pullDomainEvents().map((event) => event.eventType)).toEqual([
      'catalog.item.created',
    ])
    expect(item.pullDomainEvents()).toEqual([])
    expect(item.deactivate(new Date()).isRight()).toBe(true)
    expect(item.pullDomainEvents()[0]?.payloadOf()).toEqual({ itemId: item.id.toString() })
    expect(item.deactivate(new Date()).isLeft()).toBe(true)
  })

  it('keeps a price list currency consistent and snapshots bigint safely', () => {
    const currency = unwrap(Currency.create('brl'))
    const list = PriceList.create({
      tenantId: randomUUID(),
      name: unwrap(CatalogName.create('Base')),
      currency,
    })
    expect(
      list.setPrice(randomUUID(), unwrap(Money.create('12345', currency)), new Date()).isRight(),
    ).toBe(true)
    expect(list.pullDomainEvents()[0]?.payloadOf()).toMatchObject({ amount: '12345' })
    expect(
      list
        .setPrice(
          randomUUID(),
          unwrap(Money.create('10', unwrap(Currency.create('USD')))),
          new Date(),
        )
        .isLeft(),
    ).toBe(true)
    expect(Money.create('-1', currency).isLeft()).toBe(true)
  })
})
