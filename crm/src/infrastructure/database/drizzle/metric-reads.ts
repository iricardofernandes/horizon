import { type SQL, sql } from 'drizzle-orm'
import type { Transaction } from './crm-store'

/**
 * A cutoff this old can no longer change: the history refuses a fact recorded more than two
 * minutes from the database clock, and a transaction that recorded one has long ended.
 */
export const SETTLE_MS = 10 * 60_000

/** An instant as a query parameter; the raw `sql` template does not serialize a `Date`. */
const at = (instant: Date): SQL => sql`${instant.toISOString()}::timestamptz`

export type ForecastGrouping = 'pipeline' | 'owner' | 'source'

export interface ForecastQuery {
  readonly cutoff: Date
  readonly groupBy: ForecastGrouping
  readonly pipelineId: string | null
  readonly ownerId: string | null
  readonly sourceId: string | null
}

export interface ForecastRow {
  readonly month: string
  readonly key: string | null
  readonly currency: string
  readonly openCount: number
  readonly openValue: string
  readonly weightedValue: string
  readonly wonCount: number
  readonly wonValue: string
}

const GROUP_COLUMN: Record<ForecastGrouping, SQL> = {
  pipeline: sql.raw('pipeline_id'),
  owner: sql.raw('owner_id'),
  source: sql.raw('source_id'),
}

/**
 * The forecast as of the cutoff (Phase 59): every opportunity in the state it was in at that
 * instant. Open value goes to the expected close month, weighted by the stage's probability;
 * won value to the month it was won. Amounts are summed per currency, in minor units.
 */
export async function forecast(tx: Transaction, query: ForecastQuery): Promise<ForecastRow[]> {
  const key = GROUP_COLUMN[query.groupBy]
  const filters = [
    query.pipelineId ? sql`and pipeline_id = ${query.pipelineId}` : sql``,
    query.ownerId ? sql`and owner_id = ${query.ownerId}` : sql``,
    query.sourceId ? sql`and source_id = ${query.sourceId}` : sql``,
  ]
  const rows = (await tx.execute(sql`
    select
      to_char(case when status = 'won' then closed_on else expected_close_on end, 'YYYY-MM') as month,
      ${key}::text as key,
      currency,
      count(*) filter (where status = 'open')::int as open_count,
      coalesce(sum(amount) filter (where status = 'open'), 0)::text as open_value,
      coalesce(round(sum(amount::numeric * probability_bps) filter (where status = 'open') / 10000), 0)::bigint::text as weighted_value,
      count(*) filter (where status = 'won')::int as won_count,
      coalesce(sum(amount) filter (where status = 'won'), 0)::text as won_value
    from metric_states
    where valid_from <= ${at(query.cutoff)} and (valid_to is null or valid_to > ${at(query.cutoff)})
      and status in ('open', 'won') ${sql.join(filters, sql` `)}
    group by 1, 2, 3
    order by 1, 2 nulls first, 3`)) as unknown as {
    month: string
    key: string | null
    currency: string
    open_count: number
    open_value: string
    weighted_value: string
    won_count: number
    won_value: string
  }[]
  return rows.map((row) => ({
    month: row.month,
    key: row.key,
    currency: row.currency,
    openCount: row.open_count,
    openValue: row.open_value,
    weightedValue: row.weighted_value,
    wonCount: row.won_count,
    wonValue: row.won_value,
  }))
}

export interface MetricsQuery {
  readonly pipelineId: string
  readonly from: Date
  readonly to: Date
  readonly cutoff: Date
}

/**
 * How a pipeline converts (Phase 59), counting only what was recorded in the window and at
 * or before the cutoff: a visit that ended after the cutoff is still in its stage, and a
 * closure reopened after the cutoff still counts.
 */
export async function pipelineMetrics(tx: Transaction, query: MetricsQuery) {
  const { pipelineId, from, to, cutoff } = query
  const until = to.getTime() < cutoff.getTime() ? to : cutoff
  const [stages, conversions, outcomes, reasons] = await Promise.all([
    tx.execute(sql`
      select v.stage_id,
        count(*) filter (where v.entered_at >= ${at(from)} and v.entered_at <= ${at(until)})::int as entered,
        count(*) filter (where v.entered_at <= ${at(cutoff)} and (v.left_at is null or v.left_at > ${at(cutoff)}))::int as current,
        count(*) filter (where v.exit = 'moved' and ${leftIn(from, until)})::int as moved,
        count(*) filter (where v.exit = 'won' and ${leftIn(from, until)})::int as won,
        count(*) filter (where v.exit = 'lost' and ${leftIn(from, until)})::int as lost,
        coalesce(round(avg(extract(epoch from v.left_at - v.entered_at)) filter (where ${leftIn(from, until)})), 0)::bigint::text as average_seconds,
        coalesce(percentile_disc(0.5) within group (order by extract(epoch from v.left_at - v.entered_at))
          filter (where ${leftIn(from, until)}), 0)::bigint::text as median_seconds,
        min(s.position) as position
      from metric_stage_visits v
      left join pipeline_stages s on s.tenant_id = v.tenant_id and s.id = v.stage_id
      where v.pipeline_id = ${pipelineId} and v.entered_at <= ${at(cutoff)}
      group by v.stage_id
      order by position nulls last, v.stage_id`),
    tx.execute(sql`
      select v.stage_id as from_stage_id, v.to_stage_id, count(*)::int as count
      from metric_stage_visits v
      where v.pipeline_id = ${pipelineId} and v.exit = 'moved' and ${leftIn(from, until)}
      group by 1, 2 order by 1, 2`),
    tx.execute(sql`
      select count(*) filter (where outcome = 'won')::int as won,
        count(*) filter (where outcome = 'lost')::int as lost
      from metric_closures
      where pipeline_id = ${pipelineId} and ${closedIn(from, until, cutoff)}`),
    tx.execute(sql`
      select loss_reason_id, count(*)::int as count
      from metric_closures
      where pipeline_id = ${pipelineId} and outcome = 'lost' and ${closedIn(from, until, cutoff)}
      group by 1 order by 2 desc, 1`),
  ])
  const outcome = (outcomes as unknown as { won: number; lost: number }[])[0] ?? { won: 0, lost: 0 }
  const decided = outcome.won + outcome.lost
  return {
    stages: (
      stages as unknown as {
        stage_id: string
        entered: number
        current: number
        moved: number
        won: number
        lost: number
        average_seconds: string
        median_seconds: string
      }[]
    ).map((row) => ({
      stageId: row.stage_id,
      entered: row.entered,
      current: row.current,
      exits: { moved: row.moved, won: row.won, lost: row.lost },
      timeInStage: {
        count: row.moved + row.won + row.lost,
        averageSeconds: Number(row.average_seconds),
        medianSeconds: Number(row.median_seconds),
      },
    })),
    conversions: (
      conversions as unknown as { from_stage_id: string; to_stage_id: string; count: number }[]
    ).map((row) => ({
      fromStageId: row.from_stage_id,
      toStageId: row.to_stage_id,
      count: row.count,
    })),
    outcomes: {
      won: outcome.won,
      lost: outcome.lost,
      winRateBps: decided ? Math.round((outcome.won * 10_000) / decided) : null,
    },
    lossReasons: (reasons as unknown as { loss_reason_id: string; count: number }[]).map((row) => ({
      lossReasonId: row.loss_reason_id,
      count: row.count,
    })),
  }
}

function leftIn(from: Date, until: Date): SQL {
  return sql`v.left_at is not null and v.left_at >= ${at(from)} and v.left_at <= ${at(until)}`
}

/** Recorded in the window, and not reopened at or before the cutoff. */
function closedIn(from: Date, until: Date, cutoff: Date): SQL {
  return sql`recorded_at >= ${at(from)} and recorded_at <= ${at(until)}
    and (superseded_at is null or superseded_at > ${at(cutoff)})`
}
