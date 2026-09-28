import { InMemoryCatalogUnitOfWork } from 'test/repositories/in-memory-catalog-unit-of-work'
import { describe, expect, it } from 'vitest'
import type { ImportRecord } from '@/domain/imports/import-values'
import { CreateUnitUseCase } from '../use-cases/create-unit'
import { ItemImporter, minorUnitsOf, PriceImporter, UnitImporter } from './catalog-importers'
import type { ImportActor, RowKey } from './ports'

const TENANT = '01900000-0000-7000-8000-000000000001'
const context: ImportActor = {
  tenantId: TENANT,
  actor: 'admin-1',
  requestId: null,
  numbers: 'pt-BR',
  dates: 'pt-BR',
}
const clock = { now: () => new Date('2026-09-28T12:00:00Z') }

function setup() {
  const unitOfWork = new InMemoryCatalogUnitOfWork()
  const keys: RowKey[] = []
  const rows = (key: RowKey) => {
    keys.push(key)
    return unitOfWork
  }
  return {
    unitOfWork,
    keys,
    units: new UnitImporter(clock, rows),
    items: new ItemImporter(unitOfWork, clock, rows),
    prices: new PriceImporter(unitOfWork, clock, rows),
  }
}

const record = (values: Record<string, string | null>): ImportRecord => values

async function unit(unitOfWork: InMemoryCatalogUnitOfWork, code: string) {
  const created = await new CreateUnitUseCase(unitOfWork, clock).execute({
    tenantId: TENANT,
    actor: { type: 'user', id: 'admin-1' },
    code,
    name: code,
    decimalPlaces: 0,
  })
  if (created.isLeft()) throw created.value
}

describe('minor units', () => {
  it('converts a decimal by the currency’s own decimals, refusing more', () => {
    expect(minorUnitsOf('12.5', 'BRL')).toBe('1250')
    expect(minorUnitsOf('12', 'JPY')).toBe('12')
    expect(minorUnitsOf('1.234', 'KWD')).toBe('1234')
    expect(minorUnitsOf('12.50', 'JPY')).toBeNull()
    expect(minorUnitsOf('1.001', 'BRL')).toBeNull()
    expect(minorUnitsOf('-1', 'BRL')).toBeNull()
  })
})

describe('units', () => {
  it('validates the code, name and places, and keys the file by code', async () => {
    const { units } = setup()
    const session = await units.session()
    const valid = session.validate(record({ code: 'cx', name: 'Caixa', decimalPlaces: null }))
    expect(valid.isRight() && valid.value).toEqual({ code: 'CX', name: 'Caixa', decimalPlaces: 0 })
    expect(valid.isRight() && session.uniqueKey(valid.value)).toBe('CX')
    const invalid = session.validate(record({ code: '1?', name: '', decimalPlaces: '9' }))
    expect(invalid.isLeft() && invalid.value.map((issue) => issue.field)).toEqual([
      'code',
      'name',
      'decimalPlaces',
    ])
  })

  it('creates the unit through the use case, and refuses a code that exists', async () => {
    const { units, unitOfWork, keys } = setup()
    const command = { code: 'CX', name: 'Caixa', decimalPlaces: 0 }
    expect((await units.write(command, { jobId: 'j', line: 2 }, context)).isRight()).toBe(true)
    expect(unitOfWork.units).toHaveLength(1)
    expect(keys).toEqual([{ jobId: 'j', line: 2 }])
    const again = await units.write(command, { jobId: 'j', line: 3 }, context)
    expect(again.isLeft() && again.value[0]?.message).toContain('already exists')
    expect(unitOfWork.auditRecordsWritten.at(0)?.actor).toEqual({ type: 'user', id: 'admin-1' })
  })
})

describe('items', () => {
  it('resolves the unit by code and refuses a unit the catalogue lacks', async () => {
    const { items, unitOfWork } = setup()
    await unit(unitOfWork, 'UN')
    const session = await items.session(context)
    const valid = session.validate(
      record({ sku: 'caf-1', name: 'Café', kind: 'Produto', unit: 'un', ncm: '0901.21.00' }),
    )
    expect(valid.isRight() && valid.value).toMatchObject({
      sku: 'CAF-1',
      kind: 'product',
      unitId: unitOfWork.units[0]?.id.toString(),
      ncm: '09012100',
    })
    const invalid = session.validate(
      record({ sku: '', name: 'X', kind: 'coisa', unit: 'KG', ncm: '12' }),
    )
    expect(invalid.isLeft() && invalid.value.map((issue) => issue.field)).toEqual([
      'sku',
      'kind',
      'unit',
      'ncm',
    ])
  })

  it('creates the item through the use case', async () => {
    const { items, unitOfWork } = setup()
    await unit(unitOfWork, 'UN')
    const session = await items.session(context)
    const command = session.validate(
      record({ sku: 'A', name: 'Alfa', kind: null, unit: 'UN', ncm: null }),
    )
    if (command.isLeft()) throw new Error()
    const written = await items.write(command.value, { jobId: 'j', line: 2 }, context)
    expect(written.isRight()).toBe(true)
    expect(unitOfWork.items).toHaveLength(1)
    const again = await items.write(command.value, { jobId: 'j', line: 3 }, context)
    expect(again.isLeft() && again.value[0]?.message).toContain('already exists')
  })
})

describe('prices', () => {
  async function withItem() {
    const setupResult = setup()
    await unit(setupResult.unitOfWork, 'UN')
    const session = await setupResult.items.session(context)
    const command = session.validate(
      record({ sku: 'A', name: 'Alfa', kind: null, unit: 'UN', ncm: null }),
    )
    if (command.isLeft()) throw new Error()
    await setupResult.items.write(command.value, { jobId: 'j', line: 2 }, context)
    return setupResult
  }

  it('reads the price the file’s way and refuses a currency other than the list’s', async () => {
    const { prices } = await withItem()
    const session = await prices.session(context)
    const valid = session.validate(
      record({ priceList: 'Varejo', currency: 'brl', sku: 'a', price: '1.234,5' }),
    )
    expect(valid.isRight() && valid.value).toEqual({
      priceList: 'Varejo',
      currency: 'BRL',
      sku: 'A',
      amount: '123450',
    })
    const invalid = session.validate(
      record({ priceList: '', currency: 'R$', sku: 'a', price: 'x' }),
    )
    expect(invalid.isLeft() && invalid.value.map((issue) => issue.field)).toEqual([
      'priceList',
      'currency',
    ])
  })

  it('creates a missing list, sets the price, and refuses an unknown SKU', async () => {
    const { prices, unitOfWork } = await withItem()
    const command = { priceList: 'Varejo', currency: 'BRL', sku: 'A', amount: '990' }
    expect((await prices.write(command, { jobId: 'p', line: 2 }, context)).isRight()).toBe(true)
    expect(unitOfWork.priceLists).toHaveLength(1)
    expect(unitOfWork.priceLists[0]?.priceOf(unitOfWork.items[0]?.id.toString() ?? '')).toBe(990n)
    const session = await prices.session(context)
    const wrongCurrency = session.validate(
      record({ priceList: 'Varejo', currency: 'USD', sku: 'A', price: '1' }),
    )
    expect(wrongCurrency.isLeft() && wrongCurrency.value[0]?.message).toContain('in BRL')
    const unknown = await prices.write({ ...command, sku: 'Z' }, { jobId: 'p', line: 3 }, context)
    expect(unknown.isLeft() && unknown.value[0]?.field).toBe('sku')
    expect(session.uniqueKey(command)).toBe('Varejo\u0000A')
  })
})
