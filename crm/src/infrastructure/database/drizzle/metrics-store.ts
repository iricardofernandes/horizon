import { asc, eq } from 'drizzle-orm'
import type { MetricsRepository } from '@/domain/repositories/crm-repositories'
import type {
  Closure,
  MetricRows,
  MetricState,
  StageVisit,
  VisitExit,
} from '@/domain/services/opportunity-metrics'
import type { Transaction } from './crm-store'
import * as schema from './schema'

/** The metric rows of one opportunity, replaced whole (Phase 59). */
export function metricsRepository(tx: Transaction, tenantId: string): MetricsRepository {
  return {
    stored: async (opportunityId) => {
      const [states, visits, closures] = await Promise.all([
        tx
          .select()
          .from(schema.metricStates)
          .where(eq(schema.metricStates.opportunityId, opportunityId))
          .orderBy(asc(schema.metricStates.sequence)),
        tx
          .select()
          .from(schema.metricStageVisits)
          .where(eq(schema.metricStageVisits.opportunityId, opportunityId))
          .orderBy(asc(schema.metricStageVisits.enteredSequence)),
        tx
          .select()
          .from(schema.metricClosures)
          .where(eq(schema.metricClosures.opportunityId, opportunityId))
          .orderBy(asc(schema.metricClosures.sequence)),
      ])
      return {
        states: states.map(
          ({ tenantId: _, opportunityId: __, amount, status, ...row }): MetricState => ({
            ...row,
            amount: amount.toString(),
            status: status as MetricState['status'],
          }),
        ),
        visits: visits.map(
          ({ tenantId: _, opportunityId: __, exit, ...row }): StageVisit => ({
            ...row,
            exit: exit as VisitExit | null,
          }),
        ),
        closures: closures.map(
          ({ tenantId: _, opportunityId: __, outcome, ...row }): Closure => ({
            ...row,
            outcome: outcome as Closure['outcome'],
          }),
        ),
      }
    },
    replace: async (opportunityId, rows) => replaceMetrics(tx, tenantId, opportunityId, rows),
  }
}

export async function replaceMetrics(
  tx: Transaction,
  tenantId: string,
  opportunityId: string,
  rows: MetricRows,
): Promise<void> {
  await tx.delete(schema.metricStates).where(eq(schema.metricStates.opportunityId, opportunityId))
  await tx
    .delete(schema.metricStageVisits)
    .where(eq(schema.metricStageVisits.opportunityId, opportunityId))
  await tx
    .delete(schema.metricClosures)
    .where(eq(schema.metricClosures.opportunityId, opportunityId))
  const owned = { tenantId, opportunityId }
  if (rows.states.length)
    await tx
      .insert(schema.metricStates)
      .values(rows.states.map((state) => ({ ...state, ...owned, amount: BigInt(state.amount) })))
  if (rows.visits.length)
    await tx
      .insert(schema.metricStageVisits)
      .values(rows.visits.map((visit) => ({ ...visit, ...owned })))
  if (rows.closures.length)
    await tx
      .insert(schema.metricClosures)
      .values(rows.closures.map((closure) => ({ ...closure, ...owned })))
}
