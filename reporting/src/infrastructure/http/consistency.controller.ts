import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { z } from 'zod'
import type { ConsistencyRun } from '@/application/consistency'
import { ReportingRuntime } from '@/main/reporting-runtime'
import { type ReportingRequest, RequireReportingAction, tenantOf } from './authorization'
import { commandContext } from './command-context'
import { parse } from './request-parsing'

function present(run: ConsistencyRun) {
  return {
    ...run,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
  }
}

/** Consistency checks (ADR 0063, Phase 69): run one now, and read the runs kept. */
@Controller('consistency-checks')
export class ConsistencyController {
  constructor(@Inject(ReportingRuntime) private readonly runtime: ReportingRuntime) {}

  /** With the caller's own token: the owners answer only what the caller may read. */
  @Post()
  @RequireReportingAction('reconcile')
  @HttpCode(201)
  async run(@Req() request: ReportingRequest) {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
      throw new UnauthorizedException()
    const context = commandContext(request)
    return present(
      await this.runtime.consistency.execute({
        tenantId: context.tenantId,
        actor: context.actor,
        requestId: context.requestId,
        trigger: 'manual',
        bearer: authorization.slice(7),
      }),
    )
  }

  @Get()
  @RequireReportingAction('read')
  async list(@Query() query: unknown, @Req() request: ReportingRequest) {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      query,
    )
    const runs = await this.runtime.database.consistency.list(tenantOf(request), limit)
    return { data: runs.map(present) }
  }
}
