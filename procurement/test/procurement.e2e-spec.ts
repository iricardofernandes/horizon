import { randomUUID } from 'node:crypto'
import { findEvent } from '@horizon/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DefineApprovalPolicyUseCase } from '@/application/use-cases/define-policies'
import {
  DecideOrderUseCase,
  DraftOrderFromQuotationUseCase,
  DraftOrderUseCase,
  ReviseOrderUseCase,
} from '@/application/use-cases/manage-orders'
import {
  DeclineQuotationUseCase,
  RecordQuotationUseCase,
  SelectQuotationUseCase,
} from '@/application/use-cases/manage-quotations'
import {
  DecideRequisitionUseCase,
  OpenRequisitionUseCase,
  ReviseRequisitionUseCase,
} from '@/application/use-cases/manage-requisitions'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Supplier } from '@/domain/entities/supplier'
import { LineDescription, PartyName } from '@/domain/value-objects/procurement-values'
import { ProcurementDatabase } from '@/infrastructure/database/drizzle/procurement-database'

const clock = { now: () => new Date() }
let database: ProcurementDatabase
/** The owner role: the tests read the outbox and try what the domain forbids through it. */
let administrator: ReturnType<typeof postgres>

beforeAll(() => {
  database = new ProcurementDatabase({ url: process.env.DATABASE_URL ?? '' })
  administrator = postgres(process.env.ADMIN_DATABASE_URL ?? '', { max: 1 })
})

afterAll(async () => {
  await Promise.allSettled([database?.close(), administrator?.end()])
})

function value<T>(result: { isLeft(): boolean; value: unknown }): T {
  if (result.isLeft()) throw result.value
  return result.value as T
}

const BUYER = 'user:buyer'
const MANAGER = 'user:manager'

/**
 * One workspace with a supplier, two catalogue items and a warehouse — the smallest world
 * in which a purchase is a real purchase.
 */
async function workspace() {
  const tenantId = randomUUID()
  const supplierId = randomUUID()
  const warehouseId = randomUUID()
  const paper = randomUUID()
  const toner = randomUUID()

  const context = (actor = BUYER) => ({ tenantId, actor, requestId: null })
  const idempotent = (actor = BUYER, key = randomUUID()) => ({
    ...context(actor),
    idempotencyKey: key,
  })

  // The registry and the catalogue feed these by event; the tests seed them directly,
  // because what is under test is what Procurement does with them.
  await database.inTenant(tenantId, async (scope) => {
    await scope.suppliers.create(
      Supplier.project(
        {
          tenantId,
          name: value(PartyName.create('Papelaria Central Ltda')),
          email: 'vendas@papelaria.example',
          phone: '+5511999999999',
          address: 'Rua das Flores, 100',
          active: true,
          now: clock.now(),
        },
        new UniqueEntityID(supplierId),
      ),
    )
    await scope.catalogItems.recordItem({
      tenantId,
      itemId: paper,
      description: value(LineDescription.create('Papel A4 75g, resma')),
    })
    await scope.catalogItems.recordItem({
      tenantId,
      itemId: toner,
      description: value(LineDescription.create('Toner preto 3000 páginas')),
    })
  })

  const opening = new OpenRequisitionUseCase(database, clock)
  const deciding = new DecideRequisitionUseCase(database, clock)
  const quoting = new RecordQuotationUseCase(database, clock)
  const selecting = new SelectQuotationUseCase(database, clock)
  const ordering = new DraftOrderFromQuotationUseCase(database, clock)
  const drafting = new DraftOrderUseCase(database, clock)
  const decidingOrder = new DecideOrderUseCase(database, clock)

  const openRequisition = async (lines = [{ itemId: paper, quantity: '10' }]) =>
    value<{ id: string }>(
      await opening.execute({
        context: idempotent(),
        requisition: {
          warehouseId,
          neededBy: '2026-12-31',
          lines: lines.map((line) => ({ lineId: randomUUID(), ...line })),
        },
      }),
    ).id

  const approveRequisition = async (id: string) => {
    value(await deciding.submit(context(), id))
    value(await deciding.approve(context(MANAGER), id))
  }

  const quote = async (requisitionId: string, unitPrice: string, reference = 'COT-1') => {
    const detail = await database.requisitionDetail(tenantId, requisitionId)
    return value<{ id: string; total: string }>(
      await quoting.execute({
        context: idempotent(),
        quotation: {
          requisitionId,
          supplierId,
          reference,
          quotedOn: '2026-09-16',
          currency: 'BRL',
          leadTimeDays: 10,
          paymentTermDays: [30],
          lines: (detail?.data ?? []).map((line) => ({
            lineId: line.lineId,
            itemId: line.itemId,
            quantity: line.quantity,
            unitPrice,
          })),
        },
      }),
    )
  }

  return {
    tenantId,
    supplierId,
    warehouseId,
    paper,
    toner,
    context,
    idempotent,
    openRequisition,
    approveRequisition,
    quote,
    deciding,
    selecting,
    ordering,
    drafting,
    decidingOrder,
    revising: new ReviseRequisitionUseCase(database, clock),
    revisingOrder: new ReviseOrderUseCase(database, clock),
    declining: new DeclineQuotationUseCase(database, clock),
    policies: new DefineApprovalPolicyUseCase(database, clock),
  }
}

describe('requisition to purchase order', () => {
  it('carries a need through approval, a comparison and an order', async () => {
    const shop = await workspace()
    const requisitionId = await shop.openRequisition()
    await shop.approveRequisition(requisitionId)

    const cheap = await shop.quote(requisitionId, '2000', 'COT-A')
    const dear = await shop.quote(requisitionId, '2500', 'COT-B')
    expect(BigInt(cheap.total)).toBeLessThan(BigInt(dear.total))

    const comparison = await database.quotationComparison(shop.tenantId, requisitionId)
    expect(comparison.quotations).toHaveLength(2)
    expect(comparison.lines[0]?.offers.filter((offer) => offer.best)).toHaveLength(1)
    expect(comparison.lines[0]?.offers.find((offer) => offer.best)?.unitPrice).toBe('2000')

    // Choosing one offer declines the other, so the decision is single.
    const selection = value<{ declined: number }>(
      await shop.selecting.execute({ context: shop.context(), quotationId: cheap.id }),
    )
    expect(selection.declined).toBe(1)

    const order = value<{ id: string; total: string }>(
      await shop.ordering.execute({
        context: shop.idempotent(),
        quotationId: cheap.id,
        issuedOn: '2026-09-16',
      }),
    )
    expect(order.total).toBe('20000')

    const detail = await database.orderDetail(shop.tenantId, order.id)
    expect(detail?.supplierName).toBe('Papelaria Central Ltda')
    // The lead time decides the delivery date when nobody overrides it.
    expect(detail?.expectedOn).toBe('2026-09-26')
    expect(detail?.warehouseId).toBe(shop.warehouseId)
  })

  it('refuses a second order against the same requisition', async () => {
    const shop = await workspace()
    const requisitionId = await shop.openRequisition()
    await shop.approveRequisition(requisitionId)
    const quotation = await shop.quote(requisitionId, '2000')
    value(await shop.selecting.execute({ context: shop.context(), quotationId: quotation.id }))
    const first = value<{ id: string }>(
      await shop.ordering.execute({
        context: shop.idempotent(),
        quotationId: quotation.id,
        issuedOn: '2026-09-16',
      }),
    )
    value(await shop.decidingOrder.place(shop.context(), first.id))
    value(await shop.decidingOrder.approve(shop.context(MANAGER), first.id))

    const second = await shop.ordering.execute({
      context: shop.idempotent(),
      quotationId: quotation.id,
      issuedOn: '2026-09-17',
    })
    expect(second.isLeft()).toBe(true)
  })

  it('answers a repeated request with the same requisition, not a second one', async () => {
    const shop = await workspace()
    const key = randomUUID()
    const request = {
      warehouseId: shop.warehouseId,
      neededBy: '2026-12-31',
      lines: [{ lineId: randomUUID(), itemId: shop.paper, quantity: '10' }],
    }
    const opening = new OpenRequisitionUseCase(database, clock)
    const first = value<{ id: string }>(
      await opening.execute({ context: shop.idempotent(BUYER, key), requisition: request }),
    )
    const again = value<{ id: string }>(
      await opening.execute({ context: shop.idempotent(BUYER, key), requisition: request }),
    )
    expect(again.id).toBe(first.id)
    const page = await database.listRequisitions(shop.tenantId, {
      status: null,
      limit: 50,
      offset: 0,
    })
    expect(page.total).toBe(1)
  })

  it('refuses a quotation for a line nobody asked for', async () => {
    const shop = await workspace()
    const requisitionId = await shop.openRequisition()
    await shop.approveRequisition(requisitionId)
    const refused = await new RecordQuotationUseCase(database, clock).execute({
      context: shop.idempotent(),
      quotation: {
        requisitionId,
        supplierId: shop.supplierId,
        reference: 'COT-X',
        quotedOn: '2026-09-16',
        currency: 'BRL',
        leadTimeDays: 5,
        lines: [{ lineId: randomUUID(), itemId: shop.toner, quantity: '1', unitPrice: '100' }],
      },
    })
    expect(refused.isLeft()).toBe(true)
  })
})

describe('approval thresholds', () => {
  async function orderWorth(shop: Awaited<ReturnType<typeof workspace>>, unitPrice: string) {
    return value<{ id: string; total: string }>(
      await shop.drafting.execute({
        context: shop.idempotent(),
        order: {
          supplierId: shop.supplierId,
          warehouseId: shop.warehouseId,
          currency: 'BRL',
          issuedOn: '2026-09-16',
          expectedOn: '2026-09-30',
          paymentTermDays: [30],
          lines: [{ lineId: randomUUID(), itemId: shop.paper, quantity: '1', unitPrice }],
        },
      }),
    )
  }

  it('commits an order below the threshold and holds one at it', async () => {
    const shop = await workspace()
    value(
      await shop.policies.execute({
        context: shop.context(MANAGER),
        currency: 'BRL',
        threshold: '100000',
      }),
    )
    const small = await orderWorth(shop, '99999')
    const committed = value<{ status: string; approvalState: string }>(
      await shop.decidingOrder.place(shop.context(), small.id),
    )
    expect(committed).toEqual({ status: 'approved', approvalState: 'not-required' })

    const large = await orderWorth(shop, '100000')
    const held = value<{ status: string }>(await shop.decidingOrder.place(shop.context(), large.id))
    expect(held.status).toBe('pending')
    // Four eyes: the person who placed it is not the person who may approve it.
    expect((await shop.decidingOrder.approve(shop.context(), large.id)).isLeft()).toBe(true)
    value(await shop.decidingOrder.approve(shop.context(MANAGER), large.id))
    expect((await database.orderDetail(shop.tenantId, large.id))?.status).toBe('approved')
  })

  it('asks somebody about every order when no threshold has been set', async () => {
    const shop = await workspace()
    const order = await orderWorth(shop, '1')
    const held = value<{ status: string }>(await shop.decidingOrder.place(shop.context(), order.id))
    expect(held.status).toBe('pending')
  })
})

describe('what the order publishes', () => {
  it('announces an approval that matches the published contract', async () => {
    const shop = await workspace()
    value(
      await shop.policies.execute({
        context: shop.context(MANAGER),
        currency: 'BRL',
        threshold: '0',
      }),
    )
    const order = value<{ id: string }>(
      await shop.drafting.execute({
        context: shop.idempotent(),
        order: {
          supplierId: shop.supplierId,
          warehouseId: shop.warehouseId,
          currency: 'BRL',
          issuedOn: '2026-09-16',
          expectedOn: '2026-09-30',
          paymentTermDays: [30, 60],
          lines: [{ lineId: randomUUID(), itemId: shop.paper, quantity: '3', unitPrice: '3333' }],
          charges: { freight: '1000' },
        },
      }),
    )
    value(await shop.decidingOrder.place(shop.context(), order.id))
    value(await shop.decidingOrder.approve(shop.context(MANAGER), order.id))

    const events = await administrator`
      select event_type, payload from outbox where tenant_id = ${shop.tenantId}
      order by created_at`
    const approved = events.find((row) => row.event_type === 'procurement.order.approved')
    expect(approved).toBeDefined()
    const definition = findEvent('procurement.order.approved', 1)
    expect(definition?.payload.safeParse(approved?.payload).success).toBe(true)

    const payload = approved?.payload as {
      total: { amount: string }
      installments: { amount: { amount: string } }[]
    }
    // 3 × 3333 + 1000 freight, split in two without losing a minor unit.
    expect(payload.total.amount).toBe('10999')
    expect(payload.installments.map((one) => one.amount.amount)).toEqual(['5500', '5499'])
  })
})

describe('what the database refuses', () => {
  it('keeps one workspace out of another', async () => {
    const mine = await workspace()
    const theirs = await workspace()
    const requisitionId = await mine.openRequisition()
    expect(await database.requisitionDetail(theirs.tenantId, requisitionId)).toBeNull()
    const theirPage = await database.listRequisitions(theirs.tenantId, {
      status: null,
      limit: 50,
      offset: 0,
    })
    expect(theirPage.total).toBe(0)
  })

  it('will not let the lines of a committed order change, under any role', async () => {
    const shop = await workspace()
    const order = value<{ id: string }>(
      await shop.drafting.execute({
        context: shop.idempotent(),
        order: {
          supplierId: shop.supplierId,
          warehouseId: shop.warehouseId,
          currency: 'BRL',
          issuedOn: '2026-09-16',
          expectedOn: '2026-09-30',
          lines: [{ lineId: randomUUID(), itemId: shop.paper, quantity: '1', unitPrice: '1000' }],
        },
      }),
    )
    value(await shop.decidingOrder.place(shop.context(), order.id))
    await expect(
      administrator`delete from order_lines where order_id = ${order.id}::uuid`,
    ).rejects.toThrow(/cannot change once the order has been placed/)
  })

  it('will not record a second selected quotation for one requisition', async () => {
    const shop = await workspace()
    const requisitionId = await shop.openRequisition()
    await shop.approveRequisition(requisitionId)
    const first = await shop.quote(requisitionId, '2000', 'COT-A')
    const second = await shop.quote(requisitionId, '2500', 'COT-B')
    value(await shop.selecting.execute({ context: shop.context(), quotationId: first.id }))
    await expect(
      administrator`update quotations set status = 'selected' where id = ${second.id}::uuid`,
    ).rejects.toThrow(/quotations_single_selection_key/)
  })

  it('will not let the audit log be rewritten', async () => {
    const shop = await workspace()
    await shop.openRequisition()
    await expect(
      administrator`update audit_log set actor = 'nobody' where tenant_id = ${shop.tenantId}::uuid`,
    ).rejects.toThrow(/append-only/)
  })
})
