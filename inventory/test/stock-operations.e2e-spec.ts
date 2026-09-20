import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AdjustStockUseCase, DecideAdjustmentUseCase } from '@/application/use-cases/adjust-stock'
import {
  CloseStockCountUseCase,
  DecideStockCountUseCase,
  OpenStockCountUseCase,
  RecordStockCountUseCase,
} from '@/application/use-cases/count-stock'
import { DefineAdjustmentPolicyUseCase } from '@/application/use-cases/define-policies'
import { TransferStockUseCase } from '@/application/use-cases/transfer-stock'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'

const clock = { now: () => new Date() }
const KEEPER = 'user-keeper'
const MANAGER = 'user-manager'

let database: InventoryDatabase
let application: ReturnType<typeof postgres>
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new InventoryDatabase({ url: process.env.DATABASE_URL ?? '' })
  application = postgres(process.env.DATABASE_URL ?? '', { max: 1 })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), application?.end(), administrator?.end()])
})

const context = (tenantId: string, actor = KEEPER) => ({ tenantId, actor, requestId: null })
const idempotent = (tenantId: string, actor = KEEPER) => ({
  ...context(tenantId, actor),
  idempotencyKey: randomUUID(),
})

/** Two warehouses, with a hundred units of one item in the first, at 10.00 each. */
async function warehoused(options: { allowance?: string } = {}) {
  const tenantId = randomUUID()
  const main = randomUUID()
  const annex = randomUUID()
  const itemId = randomUUID()
  const balanceId = randomUUID()
  await database.provisionTenant(tenantId)
  await administrator`insert into warehouses (id, tenant_id, name, created_at, updated_at)
    values (${main}, ${tenantId}, 'Main', now(), now()),
           (${annex}, ${tenantId}, 'Annex', now(), now())`
  await administrator`insert into stock_balances
    (id, tenant_id, item_id, warehouse_id, on_hand, reserved, average_unit_cost, currency, version, updated_at)
    values (${balanceId}, ${tenantId}, ${itemId}, ${main}, 100000000, 0, 1000, 'BRL', 0, now())`
  if (options.allowance !== undefined)
    await new DefineAdjustmentPolicyUseCase(database, clock).execute({
      context: context(tenantId, MANAGER),
      currency: 'BRL',
      threshold: options.allowance,
    })
  return { tenantId, main, annex, itemId, balanceId }
}

const onHandIn = async (tenantId: string, itemId: string, warehouseId: string) => {
  const [row] = await administrator`select on_hand from stock_balances
    where tenant_id = ${tenantId} and item_id = ${itemId} and warehouse_id = ${warehouseId}`
  return row?.on_hand ?? null
}

it('writes both halves of a transfer, its document and its movements, in one transaction', async () => {
  const fixture = await warehoused()

  const moved = await new TransferStockUseCase(database, clock).execute({
    context: idempotent(fixture.tenantId),
    sourceWarehouseId: fixture.main,
    destinationWarehouseId: fixture.annex,
    lines: [{ itemId: fixture.itemId, quantity: '30' }],
    note: 'rebalancing the shelves',
  })
  if (moved.isLeft()) throw moved.value

  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.main)).toBe('70000000')
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.annex)).toBe('30000000')

  const movements = await administrator`select kind, quantity, reason, document_type, document_id
    from stock_movements where tenant_id = ${fixture.tenantId} order by kind`
  expect(movements).toEqual([
    {
      kind: 'transfer-in',
      quantity: '30000000',
      reason: 'transfer',
      document_type: 'transfer',
      document_id: moved.value.transferId,
    },
    {
      kind: 'transfer-out',
      quantity: '30000000',
      reason: 'transfer',
      document_type: 'transfer',
      document_id: moved.value.transferId,
    },
  ])

  const [transfer] = await administrator`select moved_by, note from stock_transfers
    where id = ${moved.value.transferId}`
  expect(transfer).toEqual({ moved_by: KEEPER, note: 'rebalancing the shelves' })

  // A transfer that has been made is not rewritten, whatever gets past the aggregate.
  await expect(
    administrator`update stock_transfer_lines set quantity = 1
      where transfer_id = ${moved.value.transferId}`,
  ).rejects.toThrow(/cannot be changed/)
})

it('answers a retried transfer with the one it already made', async () => {
  const fixture = await warehoused()
  const transfer = new TransferStockUseCase(database, clock)
  const command = {
    context: idempotent(fixture.tenantId),
    sourceWarehouseId: fixture.main,
    destinationWarehouseId: fixture.annex,
    lines: [{ itemId: fixture.itemId, quantity: '4' }],
  }

  const first = await transfer.execute(command)
  const retried = await transfer.execute(command)
  if (first.isLeft() || retried.isLeft()) throw new Error('the transfer was refused')
  expect(retried.value.transferId).toBe(first.value.transferId)

  const rows = await administrator`select count(*)::int as total from stock_transfers
    where tenant_id = ${fixture.tenantId}`
  expect(rows[0]?.total).toBe(1)
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.annex)).toBe('4000000')
})

it('holds an adjustment over the allowance and refuses the asker their own approval', async () => {
  const fixture = await warehoused({ allowance: '10000' })
  const adjust = new AdjustStockUseCase(database, clock)
  const decide = new DecideAdjustmentUseCase(database, clock)

  // 50 units at 10.00 is 500.00, over an allowance of 100.00.
  const asked = await adjust.execute({
    context: idempotent(fixture.tenantId),
    warehouseId: fixture.main,
    itemId: fixture.itemId,
    direction: 'out',
    quantity: '50',
    reason: 'loss',
    note: 'not on the shelf and not in the system',
  })
  if (asked.isLeft()) throw asked.value
  expect(asked.value).toMatchObject({ status: 'pending', approvalState: 'pending' })
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.main)).toBe('100000000')

  const own = await decide.execute({
    context: context(fixture.tenantId, KEEPER),
    adjustmentId: asked.value.adjustmentId,
    decision: { kind: 'approve' },
  })
  expect(own.isLeft()).toBe(true)

  // And if it ever got past the aggregate, the table says the same thing.
  await expect(
    administrator`update stock_adjustments
      set approval_state = 'approved', decided_by = ${KEEPER}, decided_at = now()
      where id = ${asked.value.adjustmentId}`,
  ).rejects.toThrow(/four_eyes/)

  const allowed = await decide.execute({
    context: context(fixture.tenantId, MANAGER),
    adjustmentId: asked.value.adjustmentId,
    decision: { kind: 'approve' },
  })
  if (allowed.isLeft()) throw allowed.value
  expect(allowed.value).toMatchObject({ status: 'posted', approvalState: 'approved' })
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.main)).toBe('50000000')

  const [movement] = await administrator`select kind, reason, document_type from stock_movements
    where tenant_id = ${fixture.tenantId}`
  expect(movement).toEqual({
    kind: 'adjustment-out',
    reason: 'loss',
    document_type: 'adjustment',
  })
})

it('posts a count as the difference against the balance, not the figure counted', async () => {
  const fixture = await warehoused({ allowance: '100000' })
  const open = new OpenStockCountUseCase(database, clock)
  const record = new RecordStockCountUseCase(database, clock)
  const close = new CloseStockCountUseCase(database, clock)

  const opened = await open.execute({
    context: idempotent(fixture.tenantId),
    warehouseId: fixture.main,
  })
  if (opened.isLeft()) throw opened.value
  expect(opened.value.lines).toBe(1)

  // Ten units leave while the aisle is being counted.
  await administrator`update stock_balances set on_hand = 90000000, version = 1
    where id = ${fixture.balanceId}`

  const recorded = await record.execute({
    context: context(fixture.tenantId),
    countId: opened.value.countId,
    counts: [{ itemId: fixture.itemId, counted: '98' }],
  })
  expect(recorded.isRight()).toBe(true)

  const closed = await close.execute({
    context: context(fixture.tenantId),
    countId: opened.value.countId,
  })
  if (closed.isLeft()) throw closed.value
  expect(closed.value).toMatchObject({ status: 'closed', variances: 1 })
  // Ninety on the shelf, less the two the count found missing — not the ninety-eight
  // counted, which would have undone the delivery that happened meanwhile.
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.main)).toBe('88000000')

  // A settled sheet takes no more figures, in the aggregate and in a trigger.
  const late = await record.execute({
    context: context(fixture.tenantId),
    countId: opened.value.countId,
    counts: [{ itemId: fixture.itemId, counted: '1' }],
  })
  expect(late.isLeft()).toBe(true)
  await expect(
    administrator`update stock_count_lines set counted = 1
      where count_id = ${opened.value.countId}`,
  ).rejects.toThrow(/no longer open/)
})

it('makes a count that writes off more than the allowance wait for somebody else', async () => {
  const fixture = await warehoused({ allowance: '10000' })
  const opened = await new OpenStockCountUseCase(database, clock).execute({
    context: idempotent(fixture.tenantId),
    warehouseId: fixture.main,
  })
  if (opened.isLeft()) throw opened.value
  await new RecordStockCountUseCase(database, clock).execute({
    context: context(fixture.tenantId),
    countId: opened.value.countId,
    counts: [{ itemId: fixture.itemId, counted: '40' }],
  })

  const closed = await new CloseStockCountUseCase(database, clock).execute({
    context: context(fixture.tenantId),
    countId: opened.value.countId,
  })
  if (closed.isLeft()) throw closed.value
  expect(closed.value).toMatchObject({ status: 'pending', approvalState: 'pending' })
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.main)).toBe('100000000')

  const refused = await new DecideStockCountUseCase(database, clock).execute({
    context: context(fixture.tenantId, MANAGER),
    countId: opened.value.countId,
    decision: { kind: 'reject', reason: 'count the back aisle again' },
  })
  if (refused.isLeft()) throw refused.value
  expect(refused.value.status).toBe('cancelled')
  // Nothing was posted, so the shelf is untouched and no movement exists.
  expect(await onHandIn(fixture.tenantId, fixture.itemId, fixture.main)).toBe('100000000')
  const movements = await administrator`select count(*)::int as total from stock_movements
    where tenant_id = ${fixture.tenantId}`
  expect(movements[0]?.total).toBe(0)
})

it('chains every decision into the audit log, under the person who took it', async () => {
  const fixture = await warehoused({ allowance: '10000' })
  const asked = await new AdjustStockUseCase(database, clock).execute({
    context: idempotent(fixture.tenantId),
    warehouseId: fixture.main,
    itemId: fixture.itemId,
    direction: 'out',
    quantity: '50',
    reason: 'expiry',
  })
  if (asked.isLeft()) throw asked.value
  await new DecideAdjustmentUseCase(database, clock).execute({
    context: context(fixture.tenantId, MANAGER),
    adjustmentId: asked.value.adjustmentId,
    decision: { kind: 'approve' },
  })

  const entries = await administrator`select sequence, actor, action, previous_hash, hash
    from audit_log where tenant_id = ${fixture.tenantId} order by sequence`
  expect(entries.map((entry) => [entry.action, entry.actor])).toEqual([
    ['policy.defined', MANAGER],
    ['adjustment.requested', KEEPER],
    ['adjustment.approved', MANAGER],
  ])
  expect(entries[0]?.previous_hash).toBe('0'.repeat(64))
  expect(entries[1]?.previous_hash).toBe(entries[0]?.hash)
  expect(entries[2]?.previous_hash).toBe(entries[1]?.hash)

  await expect(
    administrator`update audit_log set actor = 'somebody else'
      where tenant_id = ${fixture.tenantId}`,
  ).rejects.toThrow(/append-only/)
})

it('keeps one tenant out of what another tenant moved, wrote off and counted', async () => {
  const a = await warehoused({ allowance: '10000' })
  const b = await warehoused({ allowance: '10000' })

  const moved = await new TransferStockUseCase(database, clock).execute({
    context: idempotent(a.tenantId),
    sourceWarehouseId: a.main,
    destinationWarehouseId: a.annex,
    lines: [{ itemId: a.itemId, quantity: '1' }],
  })
  if (moved.isLeft()) throw moved.value
  const asked = await new AdjustStockUseCase(database, clock).execute({
    context: idempotent(a.tenantId),
    warehouseId: a.main,
    itemId: a.itemId,
    direction: 'out',
    quantity: '50',
    reason: 'loss',
  })
  if (asked.isLeft()) throw asked.value
  const opened = await new OpenStockCountUseCase(database, clock).execute({
    context: idempotent(a.tenantId),
    warehouseId: a.main,
  })
  if (opened.isLeft()) throw opened.value

  await database.inTenant(b.tenantId, async (scope) => {
    expect(await scope.transfers.findById(moved.value.transferId)).toBeNull()
    expect(await scope.adjustments.findById(asked.value.adjustmentId)).toBeNull()
    expect(await scope.counts.findById(opened.value.countId)).toBeNull()
    // B's own allowance is B's; it cannot read the one A set.
    expect((await scope.policies.list()).map((policy) => policy.tenantId)).toEqual([b.tenantId])
  })

  await application.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${b.tenantId}, true)`
    expect(
      await tx`select * from stock_transfers where id = ${moved.value.transferId}`,
    ).toHaveLength(0)
    const changed = await tx`update stock_adjustments set approval_state = 'approved'
      where id = ${asked.value.adjustmentId}`
    expect(changed.count).toBe(0)
  })
})
