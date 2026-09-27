import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { SETTLE_MS } from '@/infrastructure/database/drizzle/metric-reads'
import { CrmRuntime } from '@/main/crm-runtime'
import { type CrmRequest, RequireCrmAction, tenantOf } from './authorization'
import { id, parse } from './request-parsing'

const instant = z.iso.datetime({ offset: true })
const forecastQuery = z.object({
  cutoff: instant.optional(),
  groupBy: z.enum(['pipeline', 'owner', 'source']).default('pipeline'),
  pipelineId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  sourceId: z.uuid().optional(),
})
const metricsQuery = z.object({
  cutoff: instant.optional(),
  from: instant.optional(),
  to: instant.optional(),
})

/**
 * The forecast and the pipeline metrics, as of a declared cutoff (Phase 59). Each answer
 * names the cutoff it used and whether it is settled — old enough that no fact recorded
 * before it can still arrive, so the numbers can be reproduced later.
 */
@Controller()
export class MetricsController {
  constructor(@Inject(CrmRuntime) private readonly runtime: CrmRuntime) {}

  @Get('forecast')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async forecast(@Query() query: unknown, @Req() request: CrmRequest) {
    const parsed = parse(forecastQuery, query)
    const cutoff = this.cutoffOf(parsed.cutoff)
    const data = await this.runtime.database.forecast(tenantOf(request), {
      cutoff,
      groupBy: parsed.groupBy,
      pipelineId: parsed.pipelineId ?? null,
      ownerId: parsed.ownerId ?? null,
      sourceId: parsed.sourceId ?? null,
    })
    return { ...this.stamp(cutoff), groupBy: parsed.groupBy, data }
  }

  @Get('pipelines/:id/metrics')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async metrics(
    @Param('id') pipelineId: string,
    @Query() query: unknown,
    @Req() request: CrmRequest,
  ) {
    const tenantId = tenantOf(request)
    const parsed = parse(metricsQuery, query)
    const cutoff = this.cutoffOf(parsed.cutoff)
    const from = parsed.from ? new Date(parsed.from) : new Date(0)
    const to = parsed.to ? new Date(parsed.to) : cutoff
    if (from.getTime() > to.getTime()) throw new BadRequestException('from: must not be after to')
    if (!(await this.runtime.database.pipelineDetail(tenantId, id(pipelineId))))
      throw new NotFoundException('Pipeline was not found')
    const metrics = await this.runtime.database.pipelineMetrics(tenantId, {
      pipelineId,
      from,
      to,
      cutoff,
    })
    return { ...this.stamp(cutoff), window: { from, to }, pipelineId, ...metrics }
  }

  /** A cutoff in the future would promise numbers that can still change. */
  private cutoffOf(value: string | undefined): Date {
    const now = this.runtime.clock.now()
    const cutoff = value ? new Date(value) : now
    if (cutoff.getTime() > now.getTime())
      throw new BadRequestException('cutoff: must not be in the future')
    return cutoff
  }

  private stamp(cutoff: Date) {
    return { cutoff, settled: cutoff.getTime() <= this.runtime.clock.now().getTime() - SETTLE_MS }
  }
}
