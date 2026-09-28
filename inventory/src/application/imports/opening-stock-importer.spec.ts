import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { describe, expect, it } from 'vitest'
import type { ImportRecord } from '@/domain/imports/import-values'
import { DefineItemTrackingUseCase } from '../use-cases/define-policies'
import { CreateWarehouseUseCase } from '../use-cases/manage-inventory'
import { minorUnitsOf, OpeningStockImporter } from './opening-stock-importer'
import type { ImportActor, RowKey } from './ports'

const TENANT = '01900000-0000-7000-8000-000000000001'
const ITEM = '01900000-0000-7000-8000-00000000000a'
const context: ImportActor = {
  tenantId: TENANT,
  actor: 'admin-1',
  requestId: null,
  numbers: 'pt-BR',
  dates: 'pt-BR',
}
const clock = { now: () => new Date('2026-09-28T12:00:00Z') }

async function setup() {
  const unitOfWork = new InMemoryInventoryUnitOfWork()
  const keys: RowKey[] = []
  const importer = new OpeningStockImporter(unitOfWork, clock, (key) => {
    keys.push(key)
    return unitOfWork
  })
  const created = await new CreateWarehouseUseCase(unitOfWork, clock).execute({
    tenantId: TENANT,
    name: 'Central',
  })
  if (created.isLeft()) throw created.value
  return { unitOfWork, importer, keys, warehouseId: created.value.warehouseId }
}

const row = (values: Record<string, string | null>): ImportRecord => ({
  warehouse: 'Central',
  itemId: ITEM,
  quantity: '10',
  unitCost: '2,50',
  currency: 'BRL',
  lot: null,
  expiresOn: null,
  serials: null,
  ...values,
})

describe('validating an opening balance', () => {
  it('resolves the warehouse by name and reads amounts the file’s way', async () => {
    const { importer, warehouseId } = await setup()
    const session = await importer.session(context)
    const valid = session.validate(
      row({ quantity: '1.234,5', lot: 'l-1', expiresOn: '31/12/2027' }),
    )
    expect(valid.isRight() && valid.value).toEqual({
      warehouseId,
      itemId: ITEM,
      quantity: '1234.5',
      unitCost: '250',
      currency: 'BRL',
      lot: { code: 'L-1', expiresOn: '2027-12-31' },
      serials: [],
    })
    expect(valid.isRight() && session.uniqueKey(valid.value)).toContain('L-1')
    const serials = session.validate(row({ quantity: '2', serials: 'sn-1 | sn-2' }))
    expect(serials.isRight() && serials.value.serials).toEqual(['SN-1', 'SN-2'])
  })

  it('names every field that is wrong', async () => {
    const { importer } = await setup()
    const session = await importer.session(context)
    const invalid = session.validate(
      row({
        warehouse: 'Filial',
        itemId: 'CAF-1',
        quantity: '-1',
        unitCost: '1,234',
        expiresOn: '2027-01-01',
      }),
    )
    expect(invalid.isLeft() && invalid.value.map((issue) => issue.field)).toEqual([
      'warehouse',
      'itemId',
      'quantity',
      'unitCost',
      'expiresOn',
    ])
    const both = session.validate(row({ lot: 'L', serials: 'S1', expiresOn: 'amanhã' }))
    expect(both.isLeft() && both.value.map((issue) => issue.field)).toEqual([
      'expiresOn',
      'serials',
    ])
    const currency = session.validate(row({ currency: 'real' }))
    expect(currency.isLeft() && currency.value[0]?.field).toBe('currency')
  })

  it('converts costs by the currency’s own decimals', () => {
    expect(minorUnitsOf('2.5', 'BRL')).toBe('250')
    expect(minorUnitsOf('3', 'JPY')).toBe('3')
    expect(minorUnitsOf('2.555', 'BRL')).toBeNull()
    expect(minorUnitsOf('x', 'BRL')).toBeNull()
  })
})

describe('writing an opening balance', () => {
  it('receives the stock through the use case, keyed by the row', async () => {
    const { importer, unitOfWork, keys } = await setup()
    const session = await importer.session(context)
    const command = session.validate(row({}))
    if (command.isLeft()) throw new Error()
    const written = await importer.write(command.value, { jobId: 'j', line: 2 }, context)
    expect(written.isRight()).toBe(true)
    expect(keys).toEqual([{ jobId: 'j', line: 2 }])
    expect(unitOfWork.events.map((event) => event.eventType)).toEqual(['inventory.stock.moved'])
  })

  it('refuses a row the item’s tracking does not accept', async () => {
    const { importer, unitOfWork } = await setup()
    const tracked = await new DefineItemTrackingUseCase(unitOfWork, clock).execute({
      context: { tenantId: TENANT, actor: 'admin-1', requestId: null },
      itemId: ITEM,
      tracking: 'lot',
    })
    expect(tracked.isRight()).toBe(true)
    const session = await importer.session(context)
    const command = session.validate(row({}))
    if (command.isLeft()) throw new Error()
    const refused = await importer.write(command.value, { jobId: 'j', line: 2 }, context)
    expect(refused.isLeft() && refused.value[0]?.message).toMatch(/lot/i)
  })
})
