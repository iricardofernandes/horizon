import { randomUUID } from 'node:crypto'
import { snapshotOf } from 'test/support/snapshot-of'
import { StockBalance } from './entities/stock-balance'
import { StockReservation } from './entities/stock-reservation'
import { Warehouse } from './entities/warehouse'
import { Currency, Money, Quantity, WarehouseName } from './value-objects/inventory-values'

function unwrap<T>(result: { isLeft(): boolean; value: T }): T {
  if (result.isLeft()) throw result.value
  return result.value
}

const quantity = (value: string) => unwrap(Quantity.create(value))
const currency = unwrap(Currency.create('BRL'))
const money = (value: string) => unwrap(Money.create(value, currency))

describe('inventory domain', () => {
  it('stores quantities exactly at six decimal places', () => {
    expect(quantity('10.500000').toString()).toBe('10.5')
    expect(quantity('0.000001').micros).toBe(1n)
    expect(quantity('0').isZero()).toBe(true)
    expect(quantity('1').isLessThan(quantity('2'))).toBe(true)
    expect(quantity('1.25').plus(quantity('0.75')).toString()).toBe('2')
    expect(quantity('2').minus(quantity('0.5')).toString()).toBe('1.5')
    expect(() => Quantity.fromMicros(-1n)).toThrow('quantity cannot be negative')
    expect(Quantity.create('-1').isLeft()).toBe(true)
    expect(Quantity.create('1.0000001').isLeft()).toBe(true)
  })

  it('normalizes warehouse names and keeps tenant ownership explicit', () => {
    const tenantId = randomUUID()
    const warehouse = Warehouse.create({
      tenantId,
      name: unwrap(WarehouseName.create('  Main   warehouse  ')),
    })
    expect(snapshotOf(warehouse).name).toBe('Main warehouse')
    expect(warehouse.isActive()).toBe(true)
    expect(warehouse.belongsTo(tenantId)).toBe(true)
    expect(warehouse.belongsTo(randomUUID())).toBe(false)
    expect(WarehouseName.create(' ').isLeft()).toBe(true)
    expect(Currency.create('12').isLeft()).toBe(true)
    expect(Money.create('-1', currency).isLeft()).toBe(true)
    expect(() => Money.fromAmount(-1n, currency)).toThrow('money cannot be negative')
  })

  it('derives balance and moving-average cost from append-only receipts', () => {
    const balance = StockBalance.open({
      tenantId: randomUUID(),
      itemId: randomUUID(),
      warehouseId: randomUUID(),
    })
    expect(balance.receive(quantity('10'), money('100'), new Date()).isRight()).toBe(true)
    expect(balance.receive(quantity('10'), money('200'), new Date()).isRight()).toBe(true)
    expect(snapshotOf(balance)).toMatchObject({
      onHand: '20',
      reserved: '0',
      available: '20',
      averageUnitCost: { amount: '150', currency: 'BRL' },
      version: 2,
    })
    expect(balance.pullDomainEvents().map((event) => event.payloadOf())).toMatchObject([
      { kind: 'receipt', quantity: '10', balanceAfter: '10', balanceVersion: 1 },
      { kind: 'receipt', quantity: '10', balanceAfter: '20', balanceVersion: 2 },
    ])
    expect(balance.receive(quantity('0'), money('100'), new Date()).isLeft()).toBe(true)
    const usd = unwrap(Currency.create('USD'))
    expect(
      balance.receive(quantity('1'), unwrap(Money.create('100', usd)), new Date()).isLeft(),
    ).toBe(true)
  })

  it('never reserves more than available and ships only held stock', () => {
    const balance = StockBalance.open({
      tenantId: randomUUID(),
      itemId: randomUUID(),
      warehouseId: randomUUID(),
    })
    unwrap(balance.receive(quantity('20'), money('125'), new Date()))
    balance.pullDomainEvents()
    expect(balance.hold(quantity('15'), new Date()).isRight()).toBe(true)
    expect(balance.hold(quantity('0'), new Date()).isLeft()).toBe(true)
    expect(balance.hold(quantity('6'), new Date()).isLeft()).toBe(true)
    expect(balance.release(quantity('16'), new Date()).isLeft()).toBe(true)
    expect(balance.release(quantity('5'), new Date()).isRight()).toBe(true)
    expect(balance.ship(quantity('11'), new Date()).isLeft()).toBe(true)
    expect(balance.ship(quantity('10'), new Date()).isRight()).toBe(true)
    expect(snapshotOf(balance)).toMatchObject({ onHand: '10', reserved: '0', available: '10' })
    expect(balance.pullDomainEvents()[0]?.payloadOf()).toMatchObject({
      kind: 'shipment',
      quantity: '10',
      balanceAfter: '10',
    })
  })

  it('emits one reservation outcome and allows only one terminal transition', () => {
    const now = new Date('2026-09-14T20:00:00.000Z')
    const reservation = StockReservation.accept({
      tenantId: randomUUID(),
      orderId: randomUUID(),
      orderVersion: 1,
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          warehouseId: randomUUID(),
          quantity: quantity('2.5'),
        },
      ],
      expiresAt: new Date('2026-09-14T20:15:00.000Z'),
      now,
    })
    expect(reservation.pullDomainEvents()[0]?.payloadOf()).toMatchObject({
      orderVersion: 1,
      expiresAt: '2026-09-14T20:15:00.000Z',
      lines: [{ quantity: '2.5' }],
    })
    expect(
      reservation.release('cancelled', 2, new Date('2026-09-14T20:01:00.000Z')).isRight(),
    ).toBe(true)
    expect(reservation.confirm(3, new Date('2026-09-14T20:02:00.000Z')).isLeft()).toBe(true)
    expect(reservation.pullDomainEvents()[0]?.payloadOf()).toMatchObject({
      orderVersion: 2,
      reason: 'cancelled',
      releasedAt: '2026-09-14T20:01:00.000Z',
    })
  })

  it('refuses to confirm an expired reservation', () => {
    const reservation = StockReservation.accept({
      tenantId: randomUUID(),
      orderId: randomUUID(),
      orderVersion: 1,
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          warehouseId: randomUUID(),
          quantity: quantity('1'),
        },
      ],
      expiresAt: new Date('2026-09-14T20:00:00.000Z'),
      now: new Date('2026-09-14T19:59:00.000Z'),
    })
    expect(reservation.confirm(2, new Date('2026-09-14T20:00:00.000Z')).isLeft()).toBe(true)
  })

  it('confirms an active reservation and exposes an immutable persistence snapshot', () => {
    const tenantId = randomUUID()
    const reservation = StockReservation.accept({
      tenantId,
      orderId: randomUUID(),
      orderVersion: 4,
      lines: [
        {
          lineId: randomUUID(),
          itemId: randomUUID(),
          warehouseId: randomUUID(),
          quantity: quantity('3'),
        },
      ],
      expiresAt: new Date('2026-09-14T21:00:00.000Z'),
      now: new Date('2026-09-14T20:00:00.000Z'),
    })
    reservation.pullDomainEvents()
    expect(reservation.isExpired(new Date('2026-09-14T20:30:00.000Z'))).toBe(false)
    expect(reservation.confirm(5, new Date('2026-09-14T20:30:00.000Z')).isRight()).toBe(true)
    expect(reservation.belongsTo(tenantId)).toBe(true)
    expect(snapshotOf(reservation)).toMatchObject({
      tenantId,
      orderVersion: 5,
      status: 'confirmed',
      lines: [{ quantity: '3' }],
    })
    expect(reservation.release('cancelled', 6, new Date()).isLeft()).toBe(true)
  })

  it('requires at least one reservation line', () => {
    expect(() =>
      StockReservation.accept({
        tenantId: randomUUID(),
        orderId: randomUUID(),
        orderVersion: 1,
        lines: [],
        expiresAt: new Date('2026-09-14T21:00:00.000Z'),
        now: new Date('2026-09-14T20:00:00.000Z'),
      }),
    ).toThrow('a reservation requires at least one line')
    expect(() =>
      StockReservation.accept({
        tenantId: randomUUID(),
        orderId: randomUUID(),
        orderVersion: 0,
        lines: [
          {
            lineId: randomUUID(),
            itemId: randomUUID(),
            warehouseId: randomUUID(),
            quantity: quantity('1'),
          },
        ],
        expiresAt: new Date('2026-09-14T21:00:00.000Z'),
        now: new Date('2026-09-14T20:00:00.000Z'),
      }),
    ).toThrow('order version must be a positive safe integer')
    expect(() =>
      StockReservation.accept({
        tenantId: randomUUID(),
        orderId: randomUUID(),
        orderVersion: 1,
        lines: [
          {
            lineId: randomUUID(),
            itemId: randomUUID(),
            warehouseId: randomUUID(),
            quantity: quantity('0'),
          },
        ],
        expiresAt: new Date('2026-09-14T21:00:00.000Z'),
        now: new Date('2026-09-14T20:00:00.000Z'),
      }),
    ).toThrow('reservation quantities must be positive')
    expect(() =>
      StockReservation.accept({
        tenantId: randomUUID(),
        orderId: randomUUID(),
        orderVersion: 1,
        lines: [
          {
            lineId: randomUUID(),
            itemId: randomUUID(),
            warehouseId: randomUUID(),
            quantity: quantity('1'),
          },
        ],
        expiresAt: new Date('2026-09-14T20:00:00.000Z'),
        now: new Date('2026-09-14T20:00:00.000Z'),
      }),
    ).toThrow('reservation expiry must be after creation')
  })
})
