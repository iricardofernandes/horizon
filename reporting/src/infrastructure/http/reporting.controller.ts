import { BadRequestException, Controller, Get, Header, Inject, Query, Req } from '@nestjs/common'
import { z } from 'zod'
import { isSettled, settlementOf } from '@/domain/settlement'
import { ReportingRuntime } from '@/main/reporting-runtime'
import {
  PublicRoute,
  type ReportingRequest,
  RequireReportingAction,
  tenantOf,
} from './authorization'

const sourcesQuery = z.object({ cutoff: z.iso.datetime({ offset: true }).optional() })

@Controller()
export class ReportingController {
  constructor(@Inject(ReportingRuntime) private readonly runtime: ReportingRuntime) {}

  @Get('health/live')
  @PublicRoute()
  live() {
    return { status: 'ok' }
  }

  @Get('health/ready')
  @PublicRoute()
  async ready() {
    await this.runtime.database.ping()
    return { status: 'ok' }
  }

  /**
   * What the journal holds from each source, how far each is proven complete by a seal,
   * and whether a cutoff is settled (ADR 0058). The cutoff defaults to now.
   */
  @Get('sources')
  @RequireReportingAction('read')
  @Header('Cache-Control', 'no-store')
  async sources(@Query() query: unknown, @Req() request: ReportingRequest) {
    const parsed = sourcesQuery.safeParse(query)
    if (!parsed.success) throw new BadRequestException('cutoff: must be an ISO 8601 instant')
    const now = this.runtime.clock.now()
    const cutoff = parsed.data.cutoff ? new Date(parsed.data.cutoff) : now
    if (cutoff.getTime() > now.getTime())
      throw new BadRequestException('cutoff: must not be in the future')
    const states = await this.runtime.database.sources(tenantOf(request))
    const settlement = settlementOf(
      new Map(states.map((state) => [state.source, state.watermark])),
      cutoff,
    )
    return {
      cutoff: cutoff.toISOString(),
      settled: settlement.settled,
      sources: states.map((state) => ({
        ...state,
        settled: isSettled(state.watermark, cutoff),
      })),
    }
  }
}
