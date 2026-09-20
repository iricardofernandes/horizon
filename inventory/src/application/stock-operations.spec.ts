import { randomUUID } from 'node:crypto'
import { InMemoryInventoryUnitOfWork } from 'test/repositories/in-memory-inventory-unit-of-work'
import { beforeEach, describe, expect, it } from 'vitest'
import { Quantity } from '@/domain/value-objects/inventory-values'
import { AdjustStockUseCase, DecideAdjustmentUseCase } from './use-cases/adjust-stock'
import {
  CloseStockCountUseCase,
  DecideStockCountUseCase,
  OpenStockCountUseCase,
  RecordStockCountUseCase,
} from './use-cases/count-stock'
import { DefineAdjustmentPolicyUseCase } from './use-cases/define-policies'
import { CreateWarehouseUseCase, ReceiveStockUseCase } from './use-cases/manage-inventory'
import { TransferStockUseCase } from './use-cases/transfer-stock'

const now = new Date('2026-09-19T12:00:00.000Z')
const clock = { now: () => now }

const KEEPER = 'user-keeper'
const MANAGER = 'user-manager'

const context = (tenantId: string, actor = KEEPER) => ({ tenantId, actor, requestId: null })
const idempotent = (tenantId: string, key: string, actor = KEEPER) => ({
  ...context(tenantId, actor),
  idempotencyKey: key,
})

interface World {
  readonly unitOfWork: InMemoryInventoryUnitOfWork
  readonly tenantId: string
  readonly itemId: string
  readonly main: string
  readonly annex: string
}

/** A tenant with two warehouses and a hundred units of one item, costing 10.00 each. */
async function stocked(options: { quantity?: string } = {}): Promise<World> {
  const unitOfWork = new InMemoryInventoryUnitOfWork()
  const tenantId = randomUUID()
  const warehouses = new CreateWarehouseUseCase(unitOfWork, clock)
  const receive = new ReceiveStockUseCase(unitOfWork, clock)

  const main = await warehouses.execute({ tenantId, name: 'Main' })
  const annex = await warehouses.execute({ tenantId, name: 'Annex' })
  if (main.isLeft() || annex.isLeft()) throw new Error('could not open the warehouses')
  const itemId = randomUUID()
  const received = await receive.execute({
    tenantId,
    warehouseId: main.value.warehouseId,
    itemId,
    quantity: options.quantity ?? '100',
    unitCost: '1000',
    currency: 'BRL',
  })
  if (received.isLeft()) throw received.value
  unitOfWork.events.length = 0
  return {
    unitOfWork,
    tenantId,
    itemId,
    main: main.value.warehouseId,
    annex: annex.value.warehouseId,
  }
}

const balanceIn = (world: World, warehouseId: string) =>
  world.unitOfWork.balances.find(
    (balance) => balance.itemId() === world.itemId && balance.warehouseId() === warehouseId,
  )

describe('transferring stock between warehouses', () => {
  let world: World

  beforeEach(async () => {
    world = await stocked()
  })

  it('moves the goods and their cost, leaving the company owning the same value', async () => {
    const transfer = new TransferStockUseCase(world.unitOfWork, clock)

    const moved = await transfer.execute({
      context: idempotent(world.tenantId, 'transfer-0001'),
      sourceWarehouseId: world.main,
      destinationWarehouseId: world.annex,
      lines: [{ itemId: world.itemId, quantity: '30' }],
      note: 'rebalancing the shelves',
    })
    expect(moved.isRight()).toBe(true)

    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('70')
    expect(balanceIn(world, world.annex)?.onHand().toString()).toBe('30')
    // Arrived at the cost it left at: 70 × 1000 + 30 × 1000 is still 100 × 1000.
    expect(balanceIn(world, world.annex)?.unitCost()?.amount).toBe(1000n)

    const payloads = world.unitOfWork.events.map((event) => event.payloadOf())
    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toMatchObject({ kind: 'transfer-out', quantity: '30', reason: 'transfer' })
    expect(payloads[1]).toMatchObject({ kind: 'transfer-in', quantity: '30', reason: 'transfer' })
    // Both halves name the same document, which is what pairs them for a reader.
    expect(payloads[0]?.document).toEqual(payloads[1]?.document)
  })

  it('refuses to move goods that are promised to somebody, or to a closed warehouse', async () => {
    const transfer = new TransferStockUseCase(world.unitOfWork, clock)
    // Every unit is spoken for by an order that expects to find it where it is.
    const reserved = balanceIn(world, world.main)
    reserved?.hold(reserved.onHand(), now)
    const refused = await transfer.execute({
      context: idempotent(world.tenantId, 'transfer-0002'),
      sourceWarehouseId: world.main,
      destinationWarehouseId: world.annex,
      lines: [{ itemId: world.itemId, quantity: '1' }],
    })
    expect(refused.isLeft()).toBe(true)
  })

  it('will not transfer a warehouse to itself, and answers a retry with the same transfer', async () => {
    const transfer = new TransferStockUseCase(world.unitOfWork, clock)
    const request = {
      sourceWarehouseId: world.main,
      destinationWarehouseId: world.annex,
      lines: [{ itemId: world.itemId, quantity: '5' }],
    }

    const circular = await transfer.execute({
      context: idempotent(world.tenantId, 'transfer-0003'),
      ...request,
      destinationWarehouseId: world.main,
    })
    expect(circular.isLeft()).toBe(true)

    const first = await transfer.execute({
      context: idempotent(world.tenantId, 'transfer-0004'),
      ...request,
    })
    const retried = await transfer.execute({
      context: idempotent(world.tenantId, 'transfer-0004'),
      ...request,
    })
    if (first.isLeft() || retried.isLeft()) throw new Error('the transfer was refused')
    expect(retried.value.transferId).toBe(first.value.transferId)
    expect(world.unitOfWork.transfers).toHaveLength(1)
    expect(balanceIn(world, world.annex)?.onHand().toString()).toBe('5')
  })
})

describe('adjusting stock', () => {
  let world: World

  beforeEach(async () => {
    world = await stocked()
  })

  /** A hundred reais, against an item that costs ten. */
  const allowance = (threshold: string, currency = 'BRL') =>
    new DefineAdjustmentPolicyUseCase(world.unitOfWork, clock).execute({
      context: context(world.tenantId, MANAGER),
      currency,
      threshold,
    })

  it('writes off what is under the allowance immediately', async () => {
    await allowance('10000')
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)

    const written = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0001'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'out',
      quantity: '2',
      reason: 'breakage',
      note: 'dropped off the forklift',
    })
    if (written.isLeft()) throw written.value
    expect(written.value).toMatchObject({ status: 'posted', approvalState: 'not-required' })
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('98')
    expect(world.unitOfWork.events[0]?.payloadOf()).toMatchObject({
      kind: 'adjustment-out',
      reason: 'breakage',
      balanceAfter: '98',
    })
  })

  it('holds one over the allowance until somebody else allows it', async () => {
    await allowance('10000')
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)
    const decide = new DecideAdjustmentUseCase(world.unitOfWork, clock)

    // 50 × 10.00 is 500.00, over an allowance of 100.00.
    const asked = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0002'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'out',
      quantity: '50',
      reason: 'loss',
    })
    if (asked.isLeft()) throw asked.value
    expect(asked.value).toMatchObject({ status: 'pending', approvalState: 'pending' })
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('100')
    expect(world.unitOfWork.events).toHaveLength(0)

    const ownApproval = await decide.execute({
      context: context(world.tenantId, KEEPER),
      adjustmentId: asked.value.adjustmentId,
      decision: { kind: 'approve' },
    })
    expect(ownApproval.isLeft()).toBe(true)

    const allowed = await decide.execute({
      context: context(world.tenantId, MANAGER),
      adjustmentId: asked.value.adjustmentId,
      decision: { kind: 'approve' },
    })
    if (allowed.isLeft()) throw allowed.value
    expect(allowed.value).toMatchObject({ status: 'posted', approvalState: 'approved' })
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('50')
  })

  it('asks for every adjustment when the workspace has set no allowance', async () => {
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)

    const asked = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0003'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'out',
      quantity: '1',
      reason: 'theft',
    })
    if (asked.isLeft()) throw asked.value
    expect(asked.value.approvalState).toBe('pending')
  })

  it('refuses a reason that does not work in the direction asked for', async () => {
    await allowance('10000')
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)

    const refused = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0004'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'in',
      quantity: '1',
      reason: 'breakage',
    })
    expect(refused.isLeft()).toBe(true)
  })

  it('does not re-price stock that already has a cost, and prices stock that has none', async () => {
    await allowance('10000')
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)

    const repricing = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0005'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'in',
      quantity: '1',
      reason: 'found',
      unitCost: { amount: '5000', currency: 'BRL' },
    })
    expect(repricing.isLeft()).toBe(true)

    const unpriced = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0006'),
      warehouseId: world.annex,
      itemId: randomUUID(),
      direction: 'in',
      quantity: '4',
      reason: 'found',
    })
    expect(unpriced.isLeft()).toBe(true)

    const priced = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0007'),
      warehouseId: world.annex,
      itemId: randomUUID(),
      direction: 'in',
      quantity: '4',
      reason: 'found',
      unitCost: { amount: '250', currency: 'BRL' },
    })
    if (priced.isLeft()) throw priced.value
    expect(priced.value.status).toBe('posted')
  })

  it('refuses an approval whose goods have been promised away in the meantime', async () => {
    await allowance('10000')
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)
    const decide = new DecideAdjustmentUseCase(world.unitOfWork, clock)

    const asked = await adjust.execute({
      context: idempotent(world.tenantId, 'adjust-0008'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'out',
      quantity: '90',
      reason: 'loss',
    })
    if (asked.isLeft()) throw asked.value

    // Nothing was held while it waited, and an order took the goods.
    const balance = balanceIn(world, world.main)
    balance?.hold(balance.onHand(), now)

    const allowed = await decide.execute({
      context: context(world.tenantId, MANAGER),
      adjustmentId: asked.value.adjustmentId,
      decision: { kind: 'approve' },
    })
    expect(allowed.isLeft()).toBe(true)
  })
})

describe('counting stock', () => {
  let world: World

  beforeEach(async () => {
    world = await stocked()
    // A hundred reais: two units of a ten-real item pass, sixty of them do not.
    await new DefineAdjustmentPolicyUseCase(world.unitOfWork, clock).execute({
      context: context(world.tenantId, MANAGER),
      currency: 'BRL',
      threshold: '10000',
    })
  })

  const sheet = () => ({
    open: new OpenStockCountUseCase(world.unitOfWork, clock),
    record: new RecordStockCountUseCase(world.unitOfWork, clock),
    close: new CloseStockCountUseCase(world.unitOfWork, clock),
    decide: new DecideStockCountUseCase(world.unitOfWork, clock),
  })

  it('posts the difference against the balance, not the figure counted', async () => {
    const { open, record, close } = sheet()

    const opened = await open.execute({
      context: idempotent(world.tenantId, 'count-0001'),
      warehouseId: world.main,
    })
    if (opened.isLeft()) throw opened.value
    expect(opened.value.lines).toBe(1)

    // The counter finds 98 where the sheet said 100, and ten leave while they count.
    const ten = Quantity.fromMicros(10_000_000n)
    const balance = balanceIn(world, world.main)
    balance?.hold(ten, now)
    balance?.ship(ten, now)

    const recorded = await record.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
      counts: [{ itemId: world.itemId, counted: '98' }],
    })
    expect(recorded.isRight()).toBe(true)

    const closed = await close.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
    })
    if (closed.isLeft()) throw closed.value
    expect(closed.value).toMatchObject({ status: 'closed', variances: 1 })
    // Ninety are on the shelf after the delivery; the count takes its two off those.
    // Writing the ninety-eight that was counted would have undone the delivery.
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('88')
  })

  it('leaves a line nobody counted alone', async () => {
    const { open, record, close } = sheet()
    const other = randomUUID()
    const opened = await open.execute({
      context: idempotent(world.tenantId, 'count-0002'),
      warehouseId: world.main,
      itemIds: [world.itemId, other],
    })
    if (opened.isLeft()) throw opened.value
    expect(opened.value.lines).toBe(2)

    await record.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
      counts: [{ itemId: world.itemId, counted: '100' }],
    })
    const closed = await close.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
    })
    if (closed.isLeft()) throw closed.value
    // The item counted agreed, and the item nobody reached produced nothing.
    expect(closed.value.variances).toBe(0)
    expect(world.unitOfWork.events).toHaveLength(0)
  })

  it('makes a sheet that writes off more than the allowance wait for somebody else', async () => {
    const { open, record, close, decide } = sheet()
    const opened = await open.execute({
      context: idempotent(world.tenantId, 'count-0003'),
      warehouseId: world.main,
    })
    if (opened.isLeft()) throw opened.value

    await record.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
      counts: [{ itemId: world.itemId, counted: '40' }],
    })
    const closed = await close.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
    })
    if (closed.isLeft()) throw closed.value
    expect(closed.value).toMatchObject({ status: 'pending', approvalState: 'pending' })
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('100')

    const ownApproval = await decide.execute({
      context: context(world.tenantId, KEEPER),
      countId: opened.value.countId,
      decision: { kind: 'approve' },
    })
    expect(ownApproval.isLeft()).toBe(true)

    const allowed = await decide.execute({
      context: context(world.tenantId, MANAGER),
      countId: opened.value.countId,
      decision: { kind: 'approve' },
    })
    if (allowed.isLeft()) throw allowed.value
    expect(allowed.value.status).toBe('closed')
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('40')
  })

  it('posts nothing when the sheet is refused or abandoned', async () => {
    const { open, record, close, decide } = sheet()
    const opened = await open.execute({
      context: idempotent(world.tenantId, 'count-0004'),
      warehouseId: world.main,
    })
    if (opened.isLeft()) throw opened.value
    await record.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
      counts: [{ itemId: world.itemId, counted: '10' }],
    })
    await close.execute({ context: context(world.tenantId), countId: opened.value.countId })

    const refused = await decide.execute({
      context: context(world.tenantId, MANAGER),
      countId: opened.value.countId,
      decision: { kind: 'reject', reason: 'count the back aisle again' },
    })
    if (refused.isLeft()) throw refused.value
    expect(refused.value.status).toBe('cancelled')
    expect(balanceIn(world, world.main)?.onHand().toString()).toBe('100')
    expect(world.unitOfWork.events).toHaveLength(0)
  })

  it('takes no more figures once it has been settled', async () => {
    const { open, record, close } = sheet()
    const opened = await open.execute({
      context: idempotent(world.tenantId, 'count-0005'),
      warehouseId: world.main,
    })
    if (opened.isLeft()) throw opened.value
    await record.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
      counts: [{ itemId: world.itemId, counted: '99' }],
    })
    await close.execute({ context: context(world.tenantId), countId: opened.value.countId })

    const late = await record.execute({
      context: context(world.tenantId),
      countId: opened.value.countId,
      counts: [{ itemId: world.itemId, counted: '1' }],
    })
    expect(late.isLeft()).toBe(true)
  })
})

describe('the audit trail', () => {
  it('names who decided what, in order', async () => {
    const world = await stocked()
    await new DefineAdjustmentPolicyUseCase(world.unitOfWork, clock).execute({
      context: context(world.tenantId, MANAGER),
      currency: 'BRL',
      threshold: '0',
    })
    const adjust = new AdjustStockUseCase(world.unitOfWork, clock)
    const decide = new DecideAdjustmentUseCase(world.unitOfWork, clock)

    const asked = await adjust.execute({
      context: idempotent(world.tenantId, 'audit-0001'),
      warehouseId: world.main,
      itemId: world.itemId,
      direction: 'out',
      quantity: '1',
      reason: 'expiry',
    })
    if (asked.isLeft()) throw asked.value
    await decide.execute({
      context: context(world.tenantId, MANAGER),
      adjustmentId: asked.value.adjustmentId,
      decision: { kind: 'approve' },
    })

    expect(world.unitOfWork.auditRecords.map((record) => [record.action, record.actor])).toEqual([
      ['policy.defined', MANAGER],
      ['adjustment.requested', KEEPER],
      ['adjustment.approved', MANAGER],
    ])
  })
})
