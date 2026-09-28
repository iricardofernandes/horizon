import { auditQuerySchema } from '@horizon/contracts'
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Req,
} from '@nestjs/common'
import { SalesRuntime } from '@/main/sales-runtime'
import { RequireSalesAction, type SalesRequest, tenantOf } from './authorization'

/** The tenant's audit log, a page at a time, with the chain's verdict (Phase 68). */
@Controller('audit')
export class AuditController {
  constructor(@Inject(SalesRuntime) private readonly runtime: SalesRuntime) {}

  @Get()
  @RequireSalesAction('read')
  async page(@Query() query: unknown, @Req() request: SalesRequest) {
    if (!request.principal?.roles.some((role) => role.module === 'sales' && role.role === 'admin'))
      throw new ForbiddenException('Reading the audit log takes the Sales admin role')
    const parsed = auditQuerySchema.safeParse(query)
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid audit query')
    const filter = parsed.data
    return this.runtime.database.auditPage(tenantOf(request), {
      actor: filter.actor,
      action: filter.action,
      subjectType: filter.subjectType,
      subjectId: filter.subjectId,
      from: filter.from ? new Date(filter.from) : undefined,
      to: filter.to ? new Date(filter.to) : undefined,
      before: filter.cursor ? Number(filter.cursor) : undefined,
      limit: filter.limit,
    })
  }
}
