import { auditQuerySchema } from '@horizon/contracts'
import { BadRequestException, Controller, Get, Inject, Query, Req } from '@nestjs/common'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { RequirePermission } from './authorization'
import { type CatalogHttpRequest, tenantOf } from './http-context'

/** The tenant's audit log, a page at a time, with the chain's verdict (Phase 68). */
@Controller('audit')
export class AuditController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  @Get()
  @RequirePermission('read', 'Audit')
  async page(@Query() query: unknown, @Req() request: CatalogHttpRequest) {
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
