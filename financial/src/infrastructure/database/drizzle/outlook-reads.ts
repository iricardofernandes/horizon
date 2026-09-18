import { sql } from 'drizzle-orm'
import type { Transaction } from './title-store'

export const OUTLOOK_GRAINS = ['day', 'week', 'month'] as const
export type OutlookGrain = (typeof OUTLOOK_GRAINS)[number]

export interface OutlookBucket {
  /** The first day of the bucket, which is also how it is labelled. */
  readonly startsOn: string
  /** What posted titles say is due in this bucket: money someone already owes. */
  readonly committedIn: string
  readonly committedOut: string
  /** What forecasts expect in it: money nobody owes yet. */
  readonly forecastIn: string
  readonly forecastOut: string
  readonly net: string
}

export interface CashFlowOutlook {
  readonly from: string
  readonly to: string
  readonly grain: OutlookGrain
  readonly buckets: readonly OutlookBucket[]
  readonly committedIn: string
  readonly committedOut: string
  readonly forecastIn: string
  readonly forecastOut: string
  readonly net: string
  /** What is already due and still unpaid, which no future bucket can contain. */
  readonly overdueIn: string
  readonly overdueOut: string
}

type OutlookRow = {
  starts_on: string
  committed_in: string
  committed_out: string
  forecast_in: string
  forecast_out: string
}

/**
 * What is still expected to come in and go out, by the date it falls due.
 *
 * Two kinds of money, reported apart and never added together into one number: what a
 * posted title says someone owes, and what a forecast expects before anyone owes anything
 * (see the `forecast` stage). A reader deciding whether next month is affordable needs to
 * know which of the two a figure is.
 *
 * Realised cash flow is the ledger's to report, from what actually moved. This is the other
 * half, and the two are meant to be read side by side.
 */
export async function cashFlowOutlook(
  tx: Transaction,
  range: { from: string; to: string },
  grain: OutlookGrain,
): Promise<CashFlowOutlook> {
  const rows = await tx.execute<OutlookRow>(sql`
    with buckets as (
      select generate_series(
        date_trunc(${grain}, ${range.from}::date),
        date_trunc(${grain}, ${range.to}::date),
        ${`1 ${grain}`}::interval
      )::date as starts_on
    ),
    due as (
      select date_trunc(${grain}, i.due_on)::date as starts_on,
        coalesce(sum(i.outstanding) filter (
          where t.status = 'posted' and t.stage = 'effective' and t.direction = 'receivable'
        ), 0) as committed_in,
        coalesce(sum(i.outstanding) filter (
          where t.status = 'posted' and t.stage = 'effective' and t.direction = 'payable'
        ), 0) as committed_out,
        coalesce(sum(i.amount) filter (
          where t.stage = 'forecast' and t.status = 'draft' and t.direction = 'receivable'
        ), 0) as forecast_in,
        coalesce(sum(i.amount) filter (
          where t.stage = 'forecast' and t.status = 'draft' and t.direction = 'payable'
        ), 0) as forecast_out
      from title_installments i
      join titles t on t.tenant_id = i.tenant_id and t.id = i.title_id
      where i.due_on between ${range.from}::date and ${range.to}::date
        and (i.outstanding > 0 or t.stage = 'forecast')
      group by 1
    )
    select b.starts_on::text as starts_on,
      coalesce(d.committed_in, 0)::text as committed_in,
      coalesce(d.committed_out, 0)::text as committed_out,
      coalesce(d.forecast_in, 0)::text as forecast_in,
      coalesce(d.forecast_out, 0)::text as forecast_out
    from buckets b
    left join due d on d.starts_on = b.starts_on
    order by b.starts_on
  `)

  const buckets = [...rows].map((row) => {
    const net =
      BigInt(row.committed_in) +
      BigInt(row.forecast_in) -
      BigInt(row.committed_out) -
      BigInt(row.forecast_out)
    return {
      startsOn: row.starts_on,
      committedIn: row.committed_in,
      committedOut: row.committed_out,
      forecastIn: row.forecast_in,
      forecastOut: row.forecast_out,
      net: net.toString(),
    }
  })

  // What fell due before the range and was never paid belongs to no bucket in it, and
  // leaving it out entirely would overstate how comfortable the period looks.
  const [overdue] = await tx.execute<{ overdue_in: string; overdue_out: string }>(sql`
    select
      coalesce(sum(i.outstanding) filter (where t.direction = 'receivable'), 0)::text as overdue_in,
      coalesce(sum(i.outstanding) filter (where t.direction = 'payable'), 0)::text as overdue_out
    from title_installments i
    join titles t on t.tenant_id = i.tenant_id and t.id = i.title_id
    where i.due_on < ${range.from}::date and i.outstanding > 0
      and t.status = 'posted' and t.stage = 'effective'
  `)

  const sum = (pick: (bucket: OutlookBucket) => string) =>
    buckets.reduce((total, bucket) => total + BigInt(pick(bucket)), 0n)
  const committedIn = sum((bucket) => bucket.committedIn)
  const committedOut = sum((bucket) => bucket.committedOut)
  const forecastIn = sum((bucket) => bucket.forecastIn)
  const forecastOut = sum((bucket) => bucket.forecastOut)
  return {
    ...range,
    grain,
    buckets,
    committedIn: committedIn.toString(),
    committedOut: committedOut.toString(),
    forecastIn: forecastIn.toString(),
    forecastOut: forecastOut.toString(),
    net: (committedIn + forecastIn - committedOut - forecastOut).toString(),
    overdueIn: overdue?.overdue_in ?? '0',
    overdueOut: overdue?.overdue_out ?? '0',
  }
}
