import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { z } from 'zod'
import type { IdempotentContext } from '@/application/use-cases/commands'
import { isReportName, NO_FILTER, REPORT_NAMES, REPORTS, type ReportName } from '@/domain/reports'
import { ReportingRuntime } from '@/main/reporting-runtime'
import {
  actorOf,
  permits,
  type ReportingRequest,
  RequireReportingAction,
  tenantOf,
} from './authorization'
import { parse, unwrap } from './request-parsing'

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/
const instant = z.iso.datetime({ offset: true })
const reportQuery = z.object({
  cutoff: instant.optional(),
  currency: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  filterId: z.uuid().optional(),
})
const filterBody = z
  .object({
    currency: z.string().nullable().optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
  })
  .strict()
const createFilter = z
  .object({
    report: z.enum(REPORT_NAMES),
    name: z.string(),
    filter: filterBody,
    shared: z.boolean().default(false),
  })
  .strict()
const changeFilter = z
  .object({
    name: z.string().optional(),
    filter: filterBody.optional(),
    shared: z.boolean().optional(),
  })
  .strict()

function reportOf(name: string): ReportName {
  if (!isReportName(name)) throw new NotFoundException('Report was not found')
  return name
}

function context(request: ReportingRequest) {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

function idempotent(request: ReportingRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...context(request), idempotencyKey: key }
}

function bearerOf(request: ReportingRequest): string {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
    throw new UnauthorizedException()
  return authorization.slice(7)
}

const shares = (request: ReportingRequest) => ({
  share: permits(request.principal?.roles ?? [], 'share'),
})

/**
 * Cross-domain reports at a cutoff, their reconciliation against the owners' own reports,
 * and saved filters (ADR 0058, Phase 62).
 */
@Controller()
export class ReportsController {
  constructor(@Inject(ReportingRuntime) private readonly runtime: ReportingRuntime) {}

  @Get('reports')
  @RequireReportingAction('read')
  catalogue() {
    return { data: REPORT_NAMES.map((name) => REPORTS[name]) }
  }

  @Get('reports/:name')
  @RequireReportingAction('read')
  @Header('Cache-Control', 'no-store')
  async report(
    @Param('name') name: string,
    @Query() query: unknown,
    @Req() request: ReportingRequest,
  ) {
    const report = reportOf(name)
    const parsed = parse(reportQuery, query)
    const filter = parsed.filterId
      ? await this.savedFilter(request, report, parsed.filterId)
      : { currency: parsed.currency, from: parsed.from, to: parsed.to }
    return unwrap(
      await this.runtime.readReport.execute({
        tenantId: tenantOf(request),
        name: report,
        cutoff: parsed.cutoff ? new Date(parsed.cutoff) : null,
        filter: unwrap(this.runtime.filterOf(filter)),
      }),
    )
  }

  @Get('dashboard')
  @RequireReportingAction('read')
  @Header('Cache-Control', 'no-store')
  async dashboard(@Query() query: unknown, @Req() request: ReportingRequest) {
    const parsed = parse(z.object({ cutoff: instant.optional() }), query)
    return unwrap(
      await this.runtime.dashboard.execute({
        tenantId: tenantOf(request),
        cutoff: parsed.cutoff ? new Date(parsed.cutoff) : null,
      }),
    )
  }

  @Post('reports/:name/reconciliations')
  @RequireReportingAction('reconcile')
  @HttpCode(201)
  async reconcile(
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request: ReportingRequest,
  ) {
    const parsed = parse(z.object({ cutoff: instant.optional() }).strict(), body ?? {})
    return unwrap(
      await this.runtime.runReconciliation.execute({
        context: idempotent(request),
        name: reportOf(name),
        cutoff: parsed.cutoff ? new Date(parsed.cutoff) : null,
        bearer: bearerOf(request),
      }),
    )
  }

  @Get('reports/:name/reconciliations')
  @RequireReportingAction('read')
  async runs(
    @Param('name') name: string,
    @Query() query: unknown,
    @Req() request: ReportingRequest,
  ) {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      query,
    )
    return {
      data: await this.runtime.database.reports.listRuns(tenantOf(request), reportOf(name), limit),
    }
  }

  @Get('saved-filters')
  @RequireReportingAction('read')
  async filters(@Query() query: unknown, @Req() request: ReportingRequest) {
    const { report } = parse(z.object({ report: z.enum(REPORT_NAMES).optional() }), query)
    return {
      data: await this.runtime.database.reports.listFilters(
        tenantOf(request),
        actorOf(request),
        report ?? null,
      ),
    }
  }

  @Post('saved-filters')
  @RequireReportingAction('save')
  @HttpCode(201)
  async saveFilter(@Body() body: unknown, @Req() request: ReportingRequest) {
    const input = parse(createFilter, body)
    return unwrap(
      await this.runtime.savedFilters.create(idempotent(request), shares(request), input),
    )
  }

  @Patch('saved-filters/:id')
  @RequireReportingAction('save')
  async changeFilter(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: ReportingRequest,
  ) {
    const input = parse(changeFilter, body)
    return unwrap(
      await this.runtime.savedFilters.update(
        context(request),
        shares(request),
        parse(z.uuid(), id),
        input,
      ),
    )
  }

  @Delete('saved-filters/:id')
  @RequireReportingAction('save')
  async removeFilter(@Param('id') id: string, @Req() request: ReportingRequest) {
    return unwrap(
      await this.runtime.savedFilters.remove(
        context(request),
        shares(request),
        parse(z.uuid(), id),
      ),
    )
  }

  /** A saved filter the caller can see, for this report. */
  private async savedFilter(request: ReportingRequest, report: ReportName, filterId: string) {
    const visible = await this.runtime.database.reports.listFilters(
      tenantOf(request),
      actorOf(request),
      report,
    )
    const saved = visible.find((filter) => filter.filterId === filterId)
    if (!saved) throw new NotFoundException('Saved filter was not found')
    return saved.filter ?? NO_FILTER
  }
}
