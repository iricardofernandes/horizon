import { uuidv7 } from 'uuidv7'
import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  type CheckDefinition,
  type CheckResult,
  checkResultOf,
  cutoffOf,
  NO_FILTER,
  type NotComparableReason,
  REPORTS,
  type ReportName,
  runOutcomeOf,
} from '@/domain/reports'
import { settlementOf } from '@/domain/settlement'
import { ownerFigures, UnreadableOwnerReport } from '../owner-figures'
import type { Clock } from '../ports/journal-store'
import type { OwnerReports, ReportingCommands, ReportReads, StoredRun } from '../ports/report-store'
import { type ReportData, reportedFigures } from '../report-data'
import { audit, type IdempotentContext, once } from './commands'

export interface ReconciliationRequest {
  readonly context: IdempotentContext
  readonly name: ReportName
  readonly cutoff: Date | null
  /** The caller's own token: owners are read with the caller's access, never more. */
  readonly bearer: string
}

/**
 * Compares a report with its owners' own reports at a settled cutoff, and keeps the run
 * with every difference (ADR 0058, Phase 62). An owner that answers the current state
 * describes the cutoff only while nothing has happened in it since, which is checked
 * before and after it is read.
 */
export class RunReconciliationUseCase {
  constructor(
    private readonly reads: ReportReads,
    private readonly owners: OwnerReports,
    private readonly commands: ReportingCommands,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: ReconciliationRequest,
  ): Promise<Either<InvalidInputError | ConflictError, StoredRun>> {
    const { tenantId } = request.context
    const cutoff = cutoffOf(request.cutoff, this.clock.now())
    if (cutoff.isLeft()) return left(cutoff.value)
    const at = cutoff.value
    const definition = REPORTS[request.name]
    const watermarks = await this.reads.watermarks(tenantId)
    if (!settlementOf(watermarks, at, definition.sources).settled)
      return left(new ConflictError('the cutoff is not settled for the sources of this report'))
    const data = await this.reads.report(tenantId, request.name, at, NO_FILTER)
    const checks: CheckResult[] = []
    for (const check of definition.checks)
      checks.push(await this.check(tenantId, check, at, data, request.bearer))
    const run: StoredRun = {
      runId: uuidv7(),
      report: request.name,
      cutoff: at,
      outcome: runOutcomeOf(checks),
      checks,
      startedBy: request.context.actor,
      startedAt: this.clock.now(),
    }
    return once(
      this.commands,
      request.context,
      'reconciliation.run',
      { report: request.name, cutoff: request.cutoff?.toISOString() ?? null },
      async (scope) => {
        await scope.runs.insert(run)
        await audit(scope, request.context, {
          action: 'reconciliation.run',
          subjectType: 'reconciliation-run',
          subjectId: run.runId,
          occurredAt: run.startedAt,
          details: { report: run.report, cutoff: run.cutoff, outcome: run.outcome },
        })
        return right(run)
      },
    )
  }

  private async check(
    tenantId: string,
    check: CheckDefinition,
    cutoff: Date,
    data: ReportData[ReportName],
    bearer: string,
  ): Promise<CheckResult> {
    const notComparable = (reason: NotComparableReason): CheckResult => ({
      check: check.name,
      outcome: 'not-comparable',
      reason,
    })
    const moved = () =>
      check.asOfCutoff
        ? Promise.resolve(false)
        : this.reads.movedAfter(tenantId, check.owner, cutoff)
    if (await moved()) return notComparable('moved-after-cutoff')
    const query: Record<string, string> = check.asOfCutoff
      ? { cutoff: cutoff.toISOString(), groupBy: 'pipeline' }
      : {}
    const answer = await this.owners.read(check.path, query, bearer)
    if (answer.status === 'forbidden') return notComparable('forbidden')
    if (answer.status === 'unavailable') return notComparable('owner-unavailable')
    let owner: ReturnType<typeof ownerFigures>
    try {
      owner = ownerFigures(check.name, answer.body)
    } catch (error) {
      if (error instanceof UnreadableOwnerReport) return notComparable('owner-unavailable')
      throw error
    }
    // Something may have happened in the owner while it was being read.
    if (await moved()) return notComparable('moved-after-cutoff')
    return checkResultOf(check.name, reportedFigures(check.name, data), owner)
  }
}
