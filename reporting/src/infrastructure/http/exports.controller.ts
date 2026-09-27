import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  Res,
  StreamableFile,
} from '@nestjs/common'
import { z } from 'zod'
import { CADENCES, FORMATS, LOCALES } from '@/domain/exports'
import { NO_FILTER, REPORT_NAMES, type ReportName } from '@/domain/reports'
import { CONTENT_TYPES } from '@/infrastructure/exports/writers'
import { ReportingRuntime } from '@/main/reporting-runtime'
import {
  actorOf,
  PublicRoute,
  permits,
  type ReportingRequest,
  RequireReportingAction,
  tenantOf,
} from './authorization'
import { commandContext, idempotentContext } from './command-context'
import { parse, unwrap } from './request-parsing'

const instant = z.iso.datetime({ offset: true })
const filterBody = z
  .object({
    currency: z.string().nullable().optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
  })
  .strict()
const exportBody = z
  .object({
    report: z.enum(REPORT_NAMES),
    filter: filterBody.optional(),
    filterId: z.uuid().optional(),
    cutoff: instant.optional(),
    format: z.enum(FORMATS),
    locale: z.enum(LOCALES).default('pt-BR'),
  })
  .strict()
const scheduleBody = z
  .object({
    report: z.enum(REPORT_NAMES),
    filter: filterBody.optional(),
    filterId: z.uuid().optional(),
    format: z.enum(FORMATS),
    locale: z.enum(LOCALES).default('pt-BR'),
    cadence: z.enum(CADENCES),
    timeZone: z.string().min(1).max(64),
    since: instant.optional(),
  })
  .strict()
const fileQuery = z.object({
  tenant: z.uuid(),
  expires: z.coerce.number().int(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
})

/** The one thing the file route needs from the HTTP response. */
interface HeaderSink {
  setHeader(name: string, value: string): unknown
}

const permissionsOf = (request: ReportingRequest) => ({
  administer: permits(request.principal?.roles ?? [], 'administer'),
})

/**
 * Reports as files, their signed download links, and schedules (ADR 0059, Phase 63).
 */
@Controller()
export class ExportsController {
  constructor(@Inject(ReportingRuntime) private readonly runtime: ReportingRuntime) {}

  @Post('exports')
  @RequireReportingAction('export')
  @HttpCode(202)
  async request(@Body() body: unknown, @Req() request: ReportingRequest) {
    const input = parse(exportBody, body)
    const filter = await this.filterOf(request, input.report, input.filter, input.filterId)
    return unwrap(
      await this.runtime.requestExport.execute(idempotentContext(request), {
        report: input.report,
        filter,
        cutoff: input.cutoff ? new Date(input.cutoff) : null,
        format: input.format,
        locale: input.locale,
      }),
    )
  }

  @Get('exports')
  @RequireReportingAction('export')
  async list(@Query() query: unknown, @Req() request: ReportingRequest) {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      query,
    )
    return {
      data: await this.runtime.readExports.list(
        commandContext(request),
        permissionsOf(request),
        limit,
      ),
    }
  }

  @Get('exports/:id')
  @RequireReportingAction('export')
  async one(@Param('id') id: string, @Req() request: ReportingRequest) {
    return unwrap(
      await this.runtime.readExports.find(
        commandContext(request),
        permissionsOf(request),
        parse(z.uuid(), id),
      ),
    )
  }

  /** A link to the file, valid for 15 minutes, for the person who asked or an administrator. */
  @Get('exports/:id/link')
  @RequireReportingAction('export')
  @Header('Cache-Control', 'no-store')
  async link(@Param('id') id: string, @Req() request: ReportingRequest) {
    const job = unwrap(
      await this.runtime.readExports.find(
        commandContext(request),
        permissionsOf(request),
        parse(z.uuid(), id),
      ),
    )
    if (job.status !== 'ready') throw new BadRequestException(`The export is ${job.status}`)
    const link = this.runtime.exportLinks.sign(
      tenantOf(request),
      job.jobId,
      this.runtime.clock.now(),
    )
    return { url: link.path, expiresAt: link.expiresAt }
  }

  /** Public: the signature, not a token, says who may open it. */
  @Get('exports/:id/file')
  @PublicRoute()
  async file(
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: HeaderSink,
  ) {
    const jobId = parse(z.uuid(), id)
    const link = fileQuery.safeParse(query)
    if (
      !link.success ||
      !this.runtime.exportLinks.verify(
        { tenantId: link.data.tenant, jobId, ...link.data },
        this.runtime.clock.now(),
      )
    )
      throw new ForbiddenException('The link is not valid, or it has expired')
    const file = await this.runtime.readExports.file(link.data.tenant, jobId)
    if (!file) throw new NotFoundException('The export file is no longer available')
    response.setHeader(
      'Digest',
      `sha-256=${Buffer.from(file.sha256 ?? '', 'hex').toString('base64')}`,
    )
    response.setHeader('Cache-Control', 'private, no-store')
    return new StreamableFile(file.bytes, {
      type: CONTENT_TYPES[file.format],
      disposition: `attachment; filename="${file.name}"`,
      length: file.bytes.length,
    })
  }

  @Post('export-schedules')
  @RequireReportingAction('schedule')
  @HttpCode(201)
  async schedule(@Body() body: unknown, @Req() request: ReportingRequest) {
    const input = parse(scheduleBody, body)
    const filter = await this.filterOf(request, input.report, input.filter, input.filterId)
    return unwrap(
      await this.runtime.exportSchedules.create(idempotentContext(request), {
        report: input.report,
        filter,
        format: input.format,
        locale: input.locale,
        cadence: input.cadence,
        timeZone: input.timeZone,
        since: input.since ? new Date(input.since) : null,
      }),
    )
  }

  @Get('export-schedules')
  @RequireReportingAction('schedule')
  async schedules(@Req() request: ReportingRequest) {
    return {
      data: await this.runtime.exportSchedules.list(
        commandContext(request),
        permissionsOf(request),
      ),
    }
  }

  @Patch('export-schedules/:id')
  @RequireReportingAction('schedule')
  async setActive(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: ReportingRequest,
  ) {
    const { active } = parse(z.object({ active: z.boolean() }).strict(), body)
    return unwrap(
      await this.runtime.exportSchedules.setActive(
        commandContext(request),
        permissionsOf(request),
        parse(z.uuid(), id),
        active,
      ),
    )
  }

  @Delete('export-schedules/:id')
  @RequireReportingAction('schedule')
  async remove(@Param('id') id: string, @Req() request: ReportingRequest) {
    return unwrap(
      await this.runtime.exportSchedules.remove(
        commandContext(request),
        permissionsOf(request),
        parse(z.uuid(), id),
      ),
    )
  }

  /** The filter typed in the body, or a saved filter the caller can see, copied. */
  private async filterOf(
    request: ReportingRequest,
    report: ReportName,
    typed: z.infer<typeof filterBody> | undefined,
    filterId: string | undefined,
  ): Promise<z.infer<typeof filterBody>> {
    if (!filterId) return typed ?? NO_FILTER
    const visible = await this.runtime.database.reports.listFilters(
      tenantOf(request),
      actorOf(request),
      report,
    )
    const saved = visible.find((filter) => filter.filterId === filterId)
    if (!saved) throw new NotFoundException('Saved filter was not found')
    return saved.filter
  }
}
