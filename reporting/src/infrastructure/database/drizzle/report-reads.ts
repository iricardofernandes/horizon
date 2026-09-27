import { type SQL, sql } from 'drizzle-orm'
import type {
  CashPosition,
  OrderToCash,
  PipelineToRevenue,
  ProcureToPay,
  ReportData,
} from '@/application/report-data'
import type { ReportFilter, ReportName } from '@/domain/reports'

/**
 * Every report is a query over the journal at the cutoff (Phase 62). The order of facts is
 * `occurred_at` and then the event id (a UUIDv7), never the order they arrived in, so a
 * late or replayed event lands where it belongs. Amounts are summed as `numeric` over
 * minor units and returned as decimal strings.
 *
 * Instants go in as ISO text cast in SQL: the raw template does not serialize a `Date`.
 */
export interface Executor {
  execute(query: SQL): Promise<unknown>
}

type Row = Record<string, unknown>

async function rows(tx: Executor, query: SQL): Promise<Row[]> {
  return (await tx.execute(query)) as unknown as Row[]
}

const text = (value: unknown) => (value === null || value === undefined ? '0' : String(value))
const int = (value: unknown) => Number(value ?? 0)

/** The journal's facts of some types of one module, up to the cutoff. */
function facts(cutoff: string, types: readonly string[]): SQL {
  const [source] = (types[0] ?? '').split('.', 1)
  return sql`(select * from event_journal where source_module = ${source ?? ''} and event_type in (${sql.join(
    types.map((type) => sql`${type}`),
    sql`, `,
  )}) and occurred_at <= ${cutoff}::timestamptz)`
}

/** A flow narrowed to the months of the filter; positions never are. */
function inMonths(column: SQL, filter: ReportFilter): SQL {
  const month = sql`to_char(${column} at time zone 'UTC', 'YYYY-MM')`
  return sql`${filter.from ? sql`${month} >= ${filter.from}` : sql`true`} and ${
    filter.to ? sql`${month} <= ${filter.to}` : sql`true`
  }`
}

function inCurrency(column: SQL, filter: ReportFilter): SQL {
  return filter.currency ? sql`${column} = ${filter.currency}` : sql`true`
}

/**
 * Every posted title as it stood at the cutoff: its origin, total, and what is still open
 * after its latest settlement fact. A reversed title owes nothing.
 */
function titles(cutoff: string): SQL {
  return sql`titles as (
    select p.payload->>'titleId' as title_id,
      case when p.event_type = 'financial.receivable.posted' then 'receivable' else 'payable' end as direction,
      p.payload->'origin'->>'type' as origin_type,
      p.payload->'total'->>'currency' as currency,
      (p.payload->'total'->>'amount')::numeric as total,
      case when r.title_id is not null then 0
        else coalesce(l.outstanding, (p.payload->'total'->>'amount')::numeric) end as outstanding
    from ${facts(cutoff, ['financial.receivable.posted', 'financial.payable.posted'])} p
    left join (
      select distinct payload->>'titleId' as title_id
      from ${facts(cutoff, ['financial.receivable.reversed', 'financial.payable.reversed'])} x
    ) r on r.title_id = p.payload->>'titleId'
    left join (
      select distinct on (payload->>'titleId') payload->>'titleId' as title_id,
        (payload->'outstanding'->>'amount')::numeric as outstanding
      from ${facts(cutoff, ['financial.settlement.recorded', 'financial.settlement.reversed'])} s
      order by payload->>'titleId', occurred_at desc, event_id desc
    ) l on l.title_id = p.payload->>'titleId'
  )`
}

/** Cash received or paid against titles, net of settlements undone. */
function settled(cutoff: string, filter: ReportFilter): SQL {
  return sql`settled as (
    select s.payload->>'titleId' as title_id,
      sum((s.payload->'received'->>'amount')::numeric) as received
    from ${facts(cutoff, ['financial.settlement.recorded'])} s
    where not exists (
      select 1 from ${facts(cutoff, ['financial.settlement.reversed'])} u
      where u.payload->>'settlementId' = s.payload->>'settlementId')
      and ${inMonths(sql`s.occurred_at`, filter)}
    group by 1
  )`
}

async function cashPosition(tx: Executor, cutoff: string, filter: ReportFilter) {
  const open = await rows(
    tx,
    sql`with ${titles(cutoff)}
      select direction, currency, sum(outstanding)::text as outstanding
      from titles where outstanding > 0 and ${inCurrency(sql`currency`, filter)}
      group by 1, 2 order by 1, 2`,
  )
  const accounts = await rows(
    tx,
    sql`select a.payload->>'accountId' as account_id, a.payload->>'currency' as currency,
        coalesce(sum(case when e.payload->>'direction' = 'inflow'
          then (e.payload->'amount'->>'amount')::numeric
          else -(e.payload->'amount'->>'amount')::numeric end), 0)::text as balance
      from ${facts(cutoff, ['treasury.account.opened'])} a
      left join ${facts(cutoff, ['treasury.entry.recorded'])} e
        on e.payload->>'accountId' = a.payload->>'accountId'
      where ${inCurrency(sql`a.payload->>'currency'`, filter)}
      group by 1, 2 order by 1`,
  )
  const side = (direction: string) =>
    open
      .filter((row) => row.direction === direction)
      .map((row) => ({ currency: String(row.currency), outstanding: text(row.outstanding) }))
  return {
    receivables: side('receivable'),
    payables: side('payable'),
    accounts: accounts.map((row) => ({
      accountId: String(row.account_id),
      currency: String(row.currency),
      balance: text(row.balance),
    })),
  } satisfies CashPosition
}

const SALES_ORIGINS = [
  'sales-order',
  'sales-shipment',
  'sales-service-delivery',
  'sales-contract-period',
]
const PURCHASE_ORIGINS = ['purchase-order', 'purchase-receipt']

/** Titles raised from some origins: raised in the months, settled in them, open now. */
async function titlesFlow(
  tx: Executor,
  cutoff: string,
  filter: ReportFilter,
  origins: readonly string[],
) {
  const found = await rows(
    tx,
    sql`with ${titles(cutoff)}, ${settled(cutoff, filter)}
      select t.currency,
        coalesce(sum(t.total) filter (where ${inMonths(sql`p.occurred_at`, filter)}), 0)::text as raised,
        coalesce(sum(s.received), 0)::text as settled,
        coalesce(sum(t.outstanding), 0)::text as open
      from titles t
      join ${facts(cutoff, ['financial.receivable.posted', 'financial.payable.posted'])} p
        on p.payload->>'titleId' = t.title_id
      left join settled s on s.title_id = t.title_id
      where t.origin_type in (${sql.join(
        origins.map((origin) => sql`${origin}`),
        sql`, `,
      )}) and ${inCurrency(sql`t.currency`, filter)}
      group by 1`,
  )
  return new Map(
    found.map((row) => [
      String(row.currency),
      { raised: text(row.raised), settled: text(row.settled), open: text(row.open) },
    ]),
  )
}

/** Sums of a money field per currency, over facts in the months of the filter. */
async function moneyByCurrency(
  tx: Executor,
  cutoff: string,
  filter: ReportFilter,
  types: readonly string[],
  field: string,
) {
  const found = await rows(
    tx,
    sql`select payload->${field}->>'currency' as currency,
        sum((payload->${field}->>'amount')::numeric)::text as amount
      from ${facts(cutoff, types)} f
      where ${inMonths(sql`occurred_at`, filter)}
        and ${inCurrency(sql`payload->${field}->>'currency'`, filter)}
      group by 1`,
  )
  return new Map(found.map((row) => [String(row.currency), text(row.amount)]))
}

/**
 * Each order's latest decision at the cutoff: confirmed or approved ones commit money; a
 * cancelled one that had been confirmed is counted apart.
 */
async function orderPositions(
  tx: Executor,
  cutoff: string,
  filter: ReportFilter,
  kind: { readonly commit: string; readonly cancel: string },
) {
  return rows(
    tx,
    sql`with latest as (
        select distinct on (payload->>'orderId') payload->>'orderId' as order_id, event_type, payload
        from ${facts(cutoff, [kind.commit, kind.cancel])} f
        order by payload->>'orderId', occurred_at desc, event_id desc
      ), committed_once as (
        select distinct on (payload->>'orderId') payload->>'orderId' as order_id,
          payload->'total'->>'currency' as currency
        from ${facts(cutoff, [kind.commit])} c
        order by payload->>'orderId', occurred_at desc, event_id desc
      )
      select c.currency,
        count(*) filter (where l.event_type = ${kind.commit})::int as committed,
        coalesce(sum((l.payload->'total'->>'amount')::numeric)
          filter (where l.event_type = ${kind.commit}), 0)::text as total,
        count(*) filter (where l.event_type = ${kind.cancel})::int as cancelled
      from latest l join committed_once c on c.order_id = l.order_id
      where ${inCurrency(sql`c.currency`, filter)}
      group by 1 order by 1`,
  )
}

const NONE = { raised: '0', settled: '0', open: '0' }

function currenciesOf(...maps: readonly (Map<string, unknown> | readonly Row[])[]): string[] {
  const found = new Set<string>()
  for (const source of maps)
    if (source instanceof Map) for (const key of source.keys()) found.add(key)
    else for (const row of source) found.add(String(row.currency))
  return [...found].sort()
}

async function orderToCash(tx: Executor, cutoff: string, filter: ReportFilter) {
  const orders = await orderPositions(tx, cutoff, filter, {
    commit: 'sales.order.confirmed',
    cancel: 'sales.order.cancelled',
  })
  const shipped = await moneyByCurrency(tx, cutoff, filter, ['sales.shipment.dispatched'], 'value')
  const returned = await moneyByCurrency(tx, cutoff, filter, ['sales.shipment.returned'], 'value')
  const receivables = await titlesFlow(tx, cutoff, filter, SALES_ORIGINS)
  const reconciled = await rows(
    tx,
    sql`select c.payload->'amount'->>'currency' as currency,
        sum((c.payload->'amount'->>'amount')::numeric)::text as amount
      from ${facts(cutoff, ['treasury.reconciliation.confirmed'])} c
      where not exists (
        select 1 from ${facts(cutoff, ['treasury.reconciliation.undone'])} u
        where u.payload->>'reconciliationId' = c.payload->>'reconciliationId')
        and ${inMonths(sql`c.occurred_at`, filter)}
        and ${inCurrency(sql`c.payload->'amount'->>'currency'`, filter)}
      group by 1`,
  )
  const bank = new Map(reconciled.map((row) => [String(row.currency), text(row.amount)]))
  return {
    currencies: currenciesOf(orders, shipped, returned, receivables, bank).map((currency) => {
      const order = orders.find((row) => row.currency === currency)
      return {
        currency,
        confirmed: { count: int(order?.committed), total: text(order?.total) },
        cancelledAfterConfirmation: int(order?.cancelled),
        shipped: shipped.get(currency) ?? '0',
        returned: returned.get(currency) ?? '0',
        receivables: receivables.get(currency) ?? NONE,
        bankReconciled: bank.get(currency) ?? '0',
      }
    }),
  } satisfies OrderToCash
}

async function procureToPay(tx: Executor, cutoff: string, filter: ReportFilter) {
  const orders = await orderPositions(tx, cutoff, filter, {
    commit: 'procurement.order.approved',
    cancel: 'procurement.order.cancelled',
  })
  const received = await moneyByCurrency(
    tx,
    cutoff,
    filter,
    ['procurement.receipt.recorded'],
    'value',
  )
  const returns = await rows(
    tx,
    sql`select r.payload->'value'->>'currency' as currency, count(*)::int as returns
      from ${facts(cutoff, ['procurement.receipt.returned'])} x
      join ${facts(cutoff, ['procurement.receipt.recorded'])} r
        on r.payload->>'receiptId' = x.payload->>'receiptId'
      where ${inMonths(sql`x.occurred_at`, filter)}
        and ${inCurrency(sql`r.payload->'value'->>'currency'`, filter)}
      group by 1`,
  )
  const payables = await titlesFlow(tx, cutoff, filter, PURCHASE_ORIGINS)
  return {
    currencies: currenciesOf(orders, received, returns, payables).map((currency) => {
      const order = orders.find((row) => row.currency === currency)
      return {
        currency,
        committed: { count: int(order?.committed), total: text(order?.total) },
        cancelledAfterApproval: int(order?.cancelled),
        received: received.get(currency) ?? '0',
        returns: int(returns.find((row) => row.currency === currency)?.returns),
        payables: payables.get(currency) ?? NONE,
      }
    }),
  } satisfies ProcureToPay
}

async function pipelineToRevenue(tx: Executor, cutoff: string, filter: ReportFilter) {
  const month = sql`left(payload->>'closedOn', 7)`
  const inRange = sql`${filter.from ? sql`${month} >= ${filter.from}` : sql`true`} and ${
    filter.to ? sql`${month} <= ${filter.to}` : sql`true`
  }`
  const closed = await rows(
    tx,
    sql`with latest as (
        select distinct on (payload->>'opportunityId') event_type, payload
        from ${facts(cutoff, ['crm.opportunity.won', 'crm.opportunity.lost', 'crm.opportunity.reopened'])} f
        order by payload->>'opportunityId', occurred_at desc, event_id desc
      ), converted as (
        select ${month} as month, payload->'value'->>'currency' as currency,
          count(*)::int as count, sum((payload->'value'->>'amount')::numeric) as value
        from ${facts(cutoff, ['crm.opportunity.converted'])} c
        where ${inRange} group by 1, 2
      ), outcomes as (
        select ${month} as month, payload->'value'->>'currency' as currency,
          count(*) filter (where event_type = 'crm.opportunity.won')::int as won_count,
          coalesce(sum((payload->'value'->>'amount')::numeric)
            filter (where event_type = 'crm.opportunity.won'), 0) as won_value,
          count(*) filter (where event_type = 'crm.opportunity.lost')::int as lost_count,
          coalesce(sum((payload->'value'->>'amount')::numeric)
            filter (where event_type = 'crm.opportunity.lost'), 0) as lost_value
        from latest where event_type <> 'crm.opportunity.reopened' and ${inRange}
        group by 1, 2
      )
      select coalesce(o.month, c.month) as month, coalesce(o.currency, c.currency) as currency,
        coalesce(o.won_count, 0) as won_count, coalesce(o.won_value, 0)::text as won_value,
        coalesce(o.lost_count, 0) as lost_count, coalesce(o.lost_value, 0)::text as lost_value,
        coalesce(c.count, 0) as converted_count, coalesce(c.value, 0)::text as converted_value
      from outcomes o full join converted c on c.month = o.month and c.currency = o.currency
      where ${inCurrency(sql`coalesce(o.currency, c.currency)`, filter)}
      order by 1, 2`,
  )
  const quotes = await rows(
    tx,
    sql`select payload->'total'->>'currency' as currency, count(*)::int as count,
        sum((payload->'total'->>'amount')::numeric)::text as total
      from ${facts(cutoff, ['sales.quote.accepted'])} q
      where jsonb_typeof(payload->'attribution') = 'object'
        and ${inMonths(sql`occurred_at`, filter)}
        and ${inCurrency(sql`payload->'total'->>'currency'`, filter)}
      group by 1 order by 1`,
  )
  return {
    months: closed.map((row) => ({
      month: String(row.month),
      currency: String(row.currency),
      won: { count: int(row.won_count), value: text(row.won_value) },
      lost: { count: int(row.lost_count), value: text(row.lost_value) },
      converted: { count: int(row.converted_count), value: text(row.converted_value) },
    })),
    quotesAccepted: quotes.map((row) => ({
      currency: String(row.currency),
      count: int(row.count),
      total: text(row.total),
    })),
  } satisfies PipelineToRevenue
}

export function readReport<N extends ReportName>(
  tx: Executor,
  name: N,
  cutoff: Date,
  filter: ReportFilter,
): Promise<ReportData[N]> {
  const at = cutoff.toISOString()
  const readers: { [K in ReportName]: () => Promise<ReportData[K]> } = {
    'cash-position': () => cashPosition(tx, at, filter),
    'order-to-cash': () => orderToCash(tx, at, filter),
    'procure-to-pay': () => procureToPay(tx, at, filter),
    'pipeline-to-revenue': () => pipelineToRevenue(tx, at, filter),
  }
  return readers[name]() as Promise<ReportData[N]>
}

export async function movedAfter(tx: Executor, source: string, cutoff: Date): Promise<boolean> {
  const [row] = await rows(
    tx,
    sql`select exists (select 1 from event_journal
      where source_module = ${source} and occurred_at > ${cutoff.toISOString()}::timestamptz) as moved`,
  )
  return row?.moved === true
}
