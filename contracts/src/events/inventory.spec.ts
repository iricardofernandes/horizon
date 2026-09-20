import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  inventoryStockMoved,
  inventoryStockReleased,
  inventoryStockReservationRejected,
  inventoryStockReserved,
} from './inventory'

const line = {
  lineId: randomUUID(),
  itemId: randomUUID(),
  warehouseId: randomUUID(),
  quantity: '2.500000',
}

describe('inventory event contracts', () => {
  it('carries every reserved line and an expiry', () => {
    expect(
      inventoryStockReserved.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 1,
        reservationId: randomUUID(),
        expiresAt: '2026-09-14T20:00:00.000Z',
        lines: [line],
      }).success,
    ).toBe(true)
    expect(
      inventoryStockReserved.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 1,
        reservationId: randomUUID(),
        expiresAt: '2026-09-14T20:00:00.000Z',
        lines: [],
      }).success,
    ).toBe(false)
  })

  it('reports a non-empty, bounded-precision shortfall', () => {
    expect(
      inventoryStockReservationRejected.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 1,
        shortfalls: [{ ...line, availableQuantity: '1.25' }],
      }).success,
    ).toBe(true)
    expect(
      inventoryStockReservationRejected.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 2,
        shortfalls: [{ ...line, quantity: '-1', availableQuantity: '0' }],
      }).success,
    ).toBe(false)
  })

  it('distinguishes release reasons and movement directions', () => {
    expect(
      inventoryStockReleased.payload.safeParse({
        orderId: randomUUID(),
        orderVersion: 3,
        reservationId: randomUUID(),
        reason: 'expired',
        releasedAt: '2026-09-14T20:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      inventoryStockMoved.payload.safeParse({
        movementId: randomUUID(),
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        kind: 'receipt',
        balanceVersion: 1,
        quantity: '10',
        balanceAfter: '10',
        unitCost: { amount: '2590', currency: 'BRL' },
      }).success,
    ).toBe(true)
    expect(
      inventoryStockMoved.payload.safeParse({
        movementId: randomUUID(),
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        kind: 'transfer',
        balanceVersion: 1,
        quantity: '10',
        balanceAfter: '10',
        unitCost: null,
      }).success,
    ).toBe(false)
  })

  it('takes a reason and the document a movement belongs to, and neither is required', () => {
    const movement = {
      movementId: randomUUID(),
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      balanceVersion: 2,
      quantity: '4',
      balanceAfter: '6',
      unitCost: { amount: '1000', currency: 'BRL' },
    }
    const transferId = randomUUID()
    // The two halves of a transfer are paired by the document they share.
    expect(
      inventoryStockMoved.payload.safeParse({
        ...movement,
        kind: 'transfer-out',
        reason: 'transfer',
        document: { type: 'transfer', id: transferId },
      }).success,
    ).toBe(true)
    expect(
      inventoryStockMoved.payload.safeParse({
        ...movement,
        kind: 'transfer-in',
        reason: 'transfer',
        document: { type: 'transfer', id: transferId },
      }).success,
    ).toBe(true)
    // A producer written before either field existed still emits a valid movement.
    expect(inventoryStockMoved.payload.safeParse({ ...movement, kind: 'receipt' }).success).toBe(
      true,
    )
    expect(
      inventoryStockMoved.payload.safeParse({ ...movement, kind: 'adjustment-out', reason: 'sold' })
        .success,
    ).toBe(false)
    expect(
      inventoryStockMoved.payload.safeParse({
        ...movement,
        kind: 'adjustment-in',
        reason: 'found',
        document: { type: 'count', id: 'not-a-uuid' },
      }).success,
    ).toBe(false)
  })
})
