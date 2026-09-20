import { sql } from 'drizzle-orm'
import { Quantity } from '@/domain/value-objects/inventory-values'
import type { Transaction } from './inventory-store'

/**
 * What the movement table can be asked, now that it answers for itself.
 *
 * Every figure here comes from `stock_movements` or from a balance, never from both at
 * once pretending to agree: a report that adds up movements and then corrects itself
 * against the balance is a report that cannot be trusted about either. The movement rows
 * carry the quantity the shelf reached and what a unit was worth once each movement had
 * been applied, which is exactly enough to say what was there, and what it was worth, on
 * any day that has already happened.
 *
 * Nothing here loads an aggregate, and nothing here names an item: the catalogue is
 * another module's, so these reports return ids and let the caller put names to them.
 */

const MICROS = sql.raw('1000000')

/** In and out, as the kinds divide. A return from a customer puts goods back. */
const INBOUND = new Set(['receipt', 'transfer-in', 'adjustment-in', 'return-in'])

/** Goods sold, less the ones that came back: what the period actually consumed. */
const SOLD = sql.raw(`case when m.kind = 'shipment' then 1 else -1 end`)

const quantity = (micros: string | number | bigint) =>
  Quantity.fromMicros(BigInt(micros)).toString()

const money = (amount: string | null, currency: string | null) =>
  amount === null || currency === null ? null : { amount, currency }

const inWarehouse = (warehouseId: string | null, column = 'm.warehouse_id') =>
  warehouseId ? sql`and ${sql.raw(column)} = ${warehouseId}` : sql``

// ------------------------------------------------------------------------- the Kardex

export interface KardexLine {
  readonly movementId: string
  readonly occurredAt: string
  readonly kind: string
  readonly direction: 'in' | 'out'
  readonly quantity: string
  /** What the goods on this line moved at; absent when they moved at no cost at all. */
  readonly unitCost: { amount: string; currency: string } | null
  readonly value: string | null
  /** Where the shelf stood afterwards, and what it was then worth. */
  readonly balance: string
  readonly balanceUnitCost: { amount: string; currency: string } | null
  readonly balanceValue: string | null
  readonly reason: string | null
  readonly document: { type: string; id: string } | null
}

export interface KardexStanding {
  readonly quantity: string
  readonly unitCost: { amount: string; currency: string } | null
  readonly value: string | null
}

export interface Kardex {
  readonly itemId: string
  readonly warehouseId: string
  readonly from: string
  readonly to: string
  readonly opening: KardexStanding
  readonly lines: readonly KardexLine[]
  readonly closing: KardexStanding
}

type StandingRow = { balance_after: string; average_after: string | null; value: string | null }

type KardexRow = StandingRow & {
  id: string
  occurred_at: string
  kind: string
  quantity: string
  unit_cost: string | null
  currency: string | null
  value_moved: string | null
  reason: string | null
  document_type: string | null
  document_id: string | null
}

/**
 * One item on one shelf, from end to end.
 *
 * A Kardex is deliberately not offered for an item across every warehouse. The same thing
 * in two buildings has two running balances and two costs, and interleaving them by the
 * clock produces a column of figures that is true of nothing anybody can walk up to and
 * count. What is held everywhere is what the position and valuation reports are for.
 *
 * The opening standing is read from the last movement before the range rather than summed
 * from the ones before it: the shelf already wrote down where it stood, and asking it is
 * both cheaper and incapable of drifting. A page in the middle of a long history is
 * therefore still exactly right, which is the point of paging it at all.
 */
export async function kardex(
  tx: Transaction,
  request: {
    itemId: string
    warehouseId: string
    from: string
    to: string
    limit: number
    offset: number
  },
): Promise<Kardex> {
  const standingAt = async (instant: string): Promise<KardexStanding> => {
    const [row] = await tx.execute<StandingRow>(sql`
      select m.balance_after::text, m.average_after::text,
        round(m.balance_after::numeric * m.average_after / ${MICROS})::text as value
      from stock_movements m
      where m.item_id = ${request.itemId} and m.warehouse_id = ${request.warehouseId}
        and m.occurred_at <= ${instant}::timestamptz
      order by m.occurred_at desc, m.balance_version desc
      limit 1
    `)
    const [balance] = await tx.execute<{ currency: string | null }>(sql`
      select b.currency from stock_balances b
      where b.item_id = ${request.itemId} and b.warehouse_id = ${request.warehouseId}
      limit 1
    `)
    return {
      quantity: quantity(row?.balance_after ?? 0n),
      unitCost: money(row?.average_after ?? null, balance?.currency ?? null),
      value: row?.value ?? null,
    }
  }

  // The instant before the range opens: what the shelf had already been left holding.
  const opening = await standingAt(new Date(Date.parse(request.from) - 1).toISOString())

  const rows = await tx.execute<KardexRow>(sql`
    select m.id, m.kind,
      to_char(m.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at, m.quantity::text, m.unit_cost::text, m.currency,
      m.balance_after::text, m.average_after::text,
      round(m.quantity::numeric * m.unit_cost / ${MICROS})::text as value_moved,
      round(m.balance_after::numeric * m.average_after / ${MICROS})::text as value,
      m.reason, m.document_type, m.document_id
    from stock_movements m
    where m.item_id = ${request.itemId} and m.warehouse_id = ${request.warehouseId}
      and m.occurred_at >= ${request.from}::timestamptz
      and m.occurred_at <= ${request.to}::timestamptz
    order by m.occurred_at, m.balance_version
    limit ${request.limit} offset ${request.offset}
  `)

  return {
    itemId: request.itemId,
    warehouseId: request.warehouseId,
    from: request.from,
    to: request.to,
    opening,
    lines: [...rows].map((row) => ({
      movementId: row.id,
      occurredAt: row.occurred_at,
      kind: row.kind,
      direction: INBOUND.has(row.kind) ? ('in' as const) : ('out' as const),
      quantity: quantity(row.quantity),
      unitCost: money(row.unit_cost, row.currency),
      value: row.value_moved,
      balance: quantity(row.balance_after),
      balanceUnitCost: money(row.average_after, row.currency),
      balanceValue: row.value,
      reason: row.reason,
      document:
        row.document_type && row.document_id
          ? { type: row.document_type, id: row.document_id }
          : null,
    })),
    closing: await standingAt(request.to),
  }
}

// ---------------------------------------------------------------------- the valuation

export interface ValuationRow {
  readonly itemId: string
  readonly warehouseId: string
  readonly quantity: string
  readonly unitCost: { amount: string; currency: string } | null
  readonly value: string
  readonly currency: string | null
}

export interface Valuation {
  readonly asOf: string
  readonly rows: readonly ValuationRow[]
  readonly totals: readonly { readonly currency: string; readonly value: string }[]
}

/**
 * What the company held, and what it was worth, at an instant that has already passed.
 *
 * Read from the movements alone: for each shelf, the last movement at or before the
 * instant already says how many were left and what one was then worth. Asked about now,
 * it returns exactly what the balance table holds — which is the whole claim the movement
 * ledger makes, and the one the tests check.
 *
 * A shelf that has been emptied is left out. Nothing is not a holding, and a valuation
 * listing every item the warehouse has ever touched is a valuation nobody reads.
 */
export async function valuation(
  tx: Transaction,
  request: { asOf: string; warehouseId: string | null },
): Promise<Valuation> {
  const rows = await tx.execute<{
    item_id: string
    warehouse_id: string
    balance_after: string
    average_after: string | null
    currency: string | null
    value: string
  }>(sql`
    with standing as (
      select distinct on (m.balance_id)
        m.balance_id, m.item_id, m.warehouse_id, m.balance_after, m.average_after
      from stock_movements m
      where m.occurred_at <= ${request.asOf}::timestamptz
        ${inWarehouse(request.warehouseId)}
      order by m.balance_id, m.occurred_at desc, m.balance_version desc
    )
    select s.item_id, s.warehouse_id, s.balance_after::text, s.average_after::text, b.currency,
      coalesce(round(s.balance_after::numeric * s.average_after / ${MICROS}), 0)::text as value
    from standing s
    join stock_balances b on b.id = s.balance_id
    where s.balance_after > 0
    order by s.warehouse_id, s.item_id
  `)
  const present = [...rows].map((row) => ({
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    quantity: quantity(row.balance_after),
    unitCost: money(row.average_after, row.currency),
    value: row.value,
    currency: row.currency,
  }))
  return { asOf: request.asOf, rows: present, totals: totalled(present) }
}

/** Sums of value by currency; a holding with no cost yet contributes to no total. */
function totalled(rows: readonly { currency: string | null; value: string }[]) {
  const sums = new Map<string, bigint>()
  for (const row of rows)
    if (row.currency) sums.set(row.currency, (sums.get(row.currency) ?? 0n) + BigInt(row.value))
  return [...sums]
    .map(([currency, value]) => ({ currency, value: value.toString() }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

// ------------------------------------------------------------------------ the position

export interface PositionRow {
  readonly itemId: string
  readonly warehouseId: string
  readonly warehouseName: string
  readonly onHand: string
  readonly reserved: string
  readonly available: string
  readonly unitCost: { amount: string; currency: string } | null
  readonly value: string | null
  readonly minimum: string | null
  readonly maximum: string | null
  /** `below` compares what is free; `above` compares what is physically there. */
  readonly alert: 'below' | 'above' | null
}

/**
 * What every shelf holds right now, with the level somebody set against it.
 *
 * Paged and filtered, unlike the warehouse listing it sits beside: that one answers "what
 * warehouses are there" and embeds a few balances for convenience, and it stops being
 * usable at the size where this report starts being needed.
 */
export async function stockPosition(
  tx: Transaction,
  filter: {
    warehouseId: string | null
    itemId: string | null
    limit: number
    offset: number
  },
): Promise<readonly PositionRow[]> {
  const rows = await tx.execute<PositionSourceRow>(sql`
    select b.item_id, b.warehouse_id, w.name as warehouse_name,
      b.on_hand::text, b.reserved::text, b.average_unit_cost::text, b.currency,
      round(b.on_hand::numeric * b.average_unit_cost / ${MICROS})::text as value,
      l.minimum::text, l.maximum::text
    from stock_balances b
    join warehouses w on w.id = b.warehouse_id
    left join stock_levels l on l.warehouse_id = b.warehouse_id and l.item_id = b.item_id
    where true
      ${inWarehouse(filter.warehouseId, 'b.warehouse_id')}
      ${filter.itemId ? sql`and b.item_id = ${filter.itemId}` : sql``}
    order by w.name, b.item_id
    limit ${filter.limit} offset ${filter.offset}
  `)
  return [...rows].map(presentPosition)
}

type PositionSourceRow = {
  item_id: string
  warehouse_id: string
  warehouse_name: string
  on_hand: string
  reserved: string
  average_unit_cost: string | null
  currency: string | null
  value: string | null
  minimum: string | null
  maximum: string | null
}

function presentPosition(row: PositionSourceRow): PositionRow {
  const onHand = BigInt(row.on_hand)
  const available = onHand - BigInt(row.reserved)
  const minimum = row.minimum === null ? null : BigInt(row.minimum)
  const maximum = row.maximum === null ? null : BigInt(row.maximum)
  return {
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    onHand: quantity(onHand),
    reserved: quantity(row.reserved),
    available: quantity(available),
    unitCost: money(row.average_unit_cost, row.currency),
    value: row.average_unit_cost === null ? null : row.value,
    minimum: minimum === null ? null : quantity(minimum),
    maximum: maximum === null ? null : quantity(maximum),
    alert: alertOf(available, onHand, minimum, maximum),
  }
}

/**
 * Short is measured against what is free, over against what is physically there.
 *
 * Goods promised to an order cannot cover the next one, so they do not count towards the
 * minimum. They do take up the shelf they are sitting on and the money that bought them,
 * so they do count towards the maximum.
 */
function alertOf(
  available: bigint,
  onHand: bigint,
  minimum: bigint | null,
  maximum: bigint | null,
): 'below' | 'above' | null {
  if (minimum !== null && available < minimum) return 'below'
  if (maximum !== null && onHand > maximum) return 'above'
  return null
}

// -------------------------------------------------------------------------- the alerts

export interface StockAlert extends PositionRow {
  readonly alert: 'below' | 'above'
  /** How much to bring in to reach the maximum, or the minimum when there is none. */
  readonly suggested: string | null
  /** How far past the maximum the shelf is. */
  readonly excess: string | null
}

/**
 * The shelves somebody should look at, worst first.
 *
 * Driven from the levels rather than from the balances, so an item a warehouse is
 * supposed to keep and currently has none of appears — which is the alert that matters
 * most and the one a query over balances alone would silently miss.
 */
export async function stockAlerts(
  tx: Transaction,
  filter: { warehouseId: string | null; limit: number; offset: number },
): Promise<readonly StockAlert[]> {
  const rows = await tx.execute<PositionSourceRow & { shortfall: string }>(sql`
    with standing as (
      select l.item_id, l.warehouse_id, w.name as warehouse_name,
        coalesce(b.on_hand, 0) as on_hand, coalesce(b.reserved, 0) as reserved,
        b.average_unit_cost, b.currency,
        round(b.on_hand::numeric * b.average_unit_cost / ${MICROS}) as value,
        l.minimum, l.maximum
      from stock_levels l
      join warehouses w on w.id = l.warehouse_id
      left join stock_balances b
        on b.warehouse_id = l.warehouse_id and b.item_id = l.item_id
      where true ${inWarehouse(filter.warehouseId, 'l.warehouse_id')}
    )
    select s.item_id, s.warehouse_id, s.warehouse_name,
      s.on_hand::text, s.reserved::text, s.average_unit_cost::text, s.currency, s.value::text,
      s.minimum::text, s.maximum::text,
      greatest(s.minimum - (s.on_hand - s.reserved), s.on_hand - coalesce(s.maximum, s.on_hand))::text
        as shortfall
    from standing s
    where (s.on_hand - s.reserved) < s.minimum
       or (s.maximum is not null and s.on_hand > s.maximum)
    order by shortfall desc, s.warehouse_name, s.item_id
    limit ${filter.limit} offset ${filter.offset}
  `)
  return [...rows].flatMap((row) => {
    const position = presentPosition(row)
    if (position.alert === null) return []
    const onHand = BigInt(row.on_hand)
    const available = onHand - BigInt(row.reserved)
    const target = row.maximum === null ? BigInt(row.minimum ?? 0) : BigInt(row.maximum)
    return [
      {
        ...position,
        alert: position.alert,
        suggested: position.alert === 'below' ? quantity(target - available) : null,
        excess:
          position.alert === 'above' && row.maximum !== null
            ? quantity(onHand - BigInt(row.maximum))
            : null,
      },
    ]
  })
}

// ------------------------------------------------------- what a period consumed, valued

export interface ConsumptionRow {
  readonly itemId: string
  readonly warehouseId: string | null
  readonly quantity: string
  readonly value: string
  readonly currency: string | null
}

export interface CostOfGoodsSold {
  readonly from: string
  readonly to: string
  readonly rows: readonly ConsumptionRow[]
  readonly totals: readonly { readonly currency: string; readonly value: string }[]
}

type ConsumptionSourceRow = {
  item_id: string
  warehouse_id: string | null
  quantity: string
  value: string
  currency: string | null
}

/**
 * What the goods that left in the period had cost the company.
 *
 * Valued at the average each shipment was priced at when it went, which is the figure the
 * balance itself used — not the average today, which would re-cost a sale from six months
 * ago with the price of last week's delivery. Returns come back off it at the cost they
 * went out at, for the same reason.
 *
 * A transfer is not here: goods in the other building are still the company's. A write-off
 * is not here either — losing stock costs money, but it is not the cost of selling
 * anything, and an ERP that buries breakage inside its margin has hidden the one number
 * the warehouse most needs to see.
 */
export async function costOfGoodsSold(
  tx: Transaction,
  request: { from: string; to: string; warehouseId: string | null },
): Promise<CostOfGoodsSold> {
  const rows = await tx.execute<ConsumptionSourceRow>(sql`
    select m.item_id, m.warehouse_id, m.currency,
      sum(${SOLD} * m.quantity)::text as quantity,
      coalesce(round(sum(${SOLD} * m.quantity::numeric * coalesce(m.unit_cost, 0)) / ${MICROS}), 0)::text
        as value
    from stock_movements m
    where m.kind in ('shipment', 'return-in')
      and m.occurred_at >= ${request.from}::timestamptz
      and m.occurred_at <= ${request.to}::timestamptz
      ${inWarehouse(request.warehouseId)}
    group by m.item_id, m.warehouse_id, m.currency
    order by m.warehouse_id, m.item_id
  `)
  const present = [...rows].map((row) => ({
    itemId: row.item_id,
    warehouseId: row.warehouse_id,
    quantity: signedQuantity(row.quantity),
    value: row.value,
    currency: row.currency,
  }))
  return { from: request.from, to: request.to, rows: present, totals: totalled(present) }
}

/** A net that has gone negative is a period whose returns outweighed its shipments. */
function signedQuantity(micros: string): string {
  const value = BigInt(micros)
  return value < 0n ? `-${quantity(-value)}` : quantity(value)
}

// ------------------------------------------------------------------------ the ABC curve

export type AbcClass = 'A' | 'B' | 'C'

export interface AbcRow extends ConsumptionRow {
  readonly rank: number
  readonly share: string
  readonly cumulativeShare: string
  readonly abcClass: AbcClass
}

export interface AbcCurve {
  readonly from: string
  readonly to: string
  readonly thresholds: { readonly a: number; readonly b: number }
  readonly rows: readonly AbcRow[]
  readonly totals: readonly { readonly currency: string; readonly value: string }[]
}

/**
 * Which items are worth the attention, by what leaving them cost.
 *
 * Ranked by the same consumption the cost-of-goods report totals, so the two can never
 * disagree about what a period sold. An item is in the class its cumulative share reaches
 * rather than the one it ends in: the item that carries the running total past eighty per
 * cent is the reason the total got there, and calling it a B because it finished at
 * eighty-one would be exactly backwards.
 *
 * The curve is drawn separately per currency, because a ranking that adds pesos to euros
 * ranks nothing. Items consumed at no recorded cost fall to the bottom, which is where an
 * item nobody can value belongs on a list about where to spend effort.
 */
export async function abcCurve(
  tx: Transaction,
  request: {
    from: string
    to: string
    warehouseId: string | null
    thresholds: { a: number; b: number }
  },
): Promise<AbcCurve> {
  const rows = await tx.execute<
    ConsumptionSourceRow & {
      rank: string
      share: string
      cumulative_share: string
      abc_class: AbcClass
    }
  >(sql`
    with consumption as (
      select m.item_id, m.currency,
        sum(${SOLD} * m.quantity) as quantity,
        coalesce(round(sum(${SOLD} * m.quantity::numeric * coalesce(m.unit_cost, 0)) / ${MICROS}), 0)
          as value
      from stock_movements m
      where m.kind in ('shipment', 'return-in')
        and m.occurred_at >= ${request.from}::timestamptz
        and m.occurred_at <= ${request.to}::timestamptz
        ${inWarehouse(request.warehouseId)}
      group by m.item_id, m.currency
    ),
    ranked as (
      select c.*,
        row_number() over (partition by c.currency order by c.value desc, c.item_id) as rank,
        sum(c.value) over (partition by c.currency) as total,
        sum(c.value) over (
          partition by c.currency order by c.value desc, c.item_id
          rows between unbounded preceding and current row
        ) as cumulative
      from consumption c
    )
    select r.item_id, null::uuid as warehouse_id, r.currency,
      r.quantity::text, r.value::text, r.rank::text,
      case when r.total = 0 then '0'
           else round(r.value * 100.0 / r.total, 4)::text end as share,
      case when r.total = 0 then '0'
           else round(r.cumulative * 100.0 / r.total, 4)::text end as cumulative_share,
      case when r.total <= 0 then 'C'
           when (r.cumulative - r.value) * 100 < r.total * ${request.thresholds.a} then 'A'
           when (r.cumulative - r.value) * 100 < r.total * ${request.thresholds.b} then 'B'
           else 'C' end as abc_class
    from ranked r
    order by r.currency nulls last, r.rank
  `)
  const present = [...rows].map((row) => ({
    itemId: row.item_id,
    warehouseId: null,
    quantity: signedQuantity(row.quantity),
    value: row.value,
    currency: row.currency,
    rank: Number(row.rank),
    share: row.share,
    cumulativeShare: row.cumulative_share,
    abcClass: row.abc_class,
  }))
  return {
    from: request.from,
    to: request.to,
    thresholds: request.thresholds,
    rows: present,
    totals: totalled(present),
  }
}
