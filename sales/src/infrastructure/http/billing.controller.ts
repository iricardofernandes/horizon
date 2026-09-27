import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import type { Either } from '@/core/either'
import { type BillingRun, RUN_OUTCOMES } from '@/domain/services/contract-billing'
import { SalesRuntime } from '@/main/sales-runtime'
import { RequireSalesAction, type SalesRequest, tenantOf } from './authorization'
import { context, idempotent } from './command-context'

const competence = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
const runInput = z.strictObject({ competence })
const listQuery = z.strictObject({ competence: competence.optional() })

function parsed<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body ?? {})
  if (!result.success) throw new BadRequestException(`Invalid ${what}`)
  return result.data
}

function runId(value: string): string {
  const result = z.uuid().safeParse(value)
  if (!result.success) throw new BadRequestException('Invalid billing run id')
  return result.data
}

/** Billing runs for a competence month, and what billing still waits for (Phase 52). */
@Controller()
export class BillingController {
  constructor(@Inject(SalesRuntime) private readonly runtime: SalesRuntime) {}

  /** What a run would bill, skip and refuse this month, and why; writes nothing. */
  @Post('billing-runs/preview')
  @RequireSalesAction('read')
  async preview(@Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(runInput, body, 'billing run')
    const preview = unwrap(
      await this.runtime.previewBillingRun.execute(context(request), input.competence),
    )
    return { ...preview, totals: totalsOf(preview.items) }
  }

  /** Start the run of a month; the same key finds the same run and finishes what is pending. */
  @Post('billing-runs')
  @RequireSalesAction('manage')
  async start(@Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(runInput, body, 'billing run')
    const run = unwrap(
      await this.runtime.startBillingRun.execute({
        context: idempotent(request),
        competence: input.competence,
      }),
    )
    return view(run)
  }

  /** Carry on with a run that stopped midway; a completed run is returned as it is. */
  @Post('billing-runs/:id/resume')
  @RequireSalesAction('manage')
  async resume(@Param('id') id: string, @Req() request: SalesRequest) {
    return view(unwrap(await this.runtime.processBillingRun.execute(context(request), runId(id))))
  }

  @Get('billing-runs')
  @RequireSalesAction('read')
  async list(@Query() query: unknown, @Req() request: SalesRequest) {
    const filter = parsed(listQuery, query, 'billing run filter')
    const runs = await this.runtime.database.listBillingRuns(
      tenantOf(request),
      filter.competence ?? null,
    )
    return runs.map((run) => {
      const { items: _items, ...rest } = view(run)
      return rest
    })
  }

  @Get('billing-runs/:id')
  @RequireSalesAction('read')
  async read(@Param('id') id: string, @Req() request: SalesRequest) {
    const run = await this.runtime.database.findBillingRun(tenantOf(request), runId(id))
    if (!run) throw new NotFoundException('Billing run was not found')
    return view(run)
  }

  /** Recent runs, and billed periods past the threshold without a receivable or an NFS-e. */
  @Get('contract-billing/overview')
  @RequireSalesAction('read')
  async overview(@Req() request: SalesRequest) {
    const tenantId = tenantOf(request)
    const thresholdSeconds = this.runtime.billingGapSeconds
    const [runs, gaps] = await Promise.all([
      this.runtime.database.listBillingRuns(tenantId, null),
      this.runtime.database.billingGaps(tenantId, new Date(Date.now() - thresholdSeconds * 1000)),
    ])
    return {
      thresholdSeconds,
      runs: runs.slice(0, 10).map((run) => {
        const { items: _items, ...rest } = view(run)
        return rest
      }),
      awaitingReceivable: gaps.filter((gap) => !gap.receivablePosted),
      awaitingNfse: gaps.filter((gap) => gap.linesWithoutNfse > 0),
    }
  }
}

function totalsOf(items: readonly { outcome: string }[]) {
  const totals: Record<string, number> = Object.fromEntries(
    RUN_OUTCOMES.map((outcome) => [outcome, 0]),
  )
  for (const item of items) totals[item.outcome] = (totals[item.outcome] ?? 0) + 1
  return totals
}

function view(run: BillingRun) {
  return {
    id: run.id,
    competence: run.competence,
    status: run.status,
    requestedBy: run.requestedBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    totals: totalsOf(run.items),
    items: run.items,
  }
}

function unwrap<T>(result: Either<{ title: string; message: string }, T>): T {
  if (result.isRight()) return result.value
  const failure = result.value
  if (failure.title === 'Conflict') throw new ConflictException(failure.message)
  if (failure.title === 'Resource not found') throw new NotFoundException(failure.message)
  throw new BadRequestException(failure.message)
}
