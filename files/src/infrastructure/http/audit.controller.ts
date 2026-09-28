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
import { FilesRuntime } from '@/main/files-runtime'
import { type FilesRequest, principalOf } from './authorization'

/** The tenant's audit log, a page at a time, with the chain's verdict (Phase 68). */
@Controller('audit')
export class AuditController {
  constructor(@Inject(FilesRuntime) private readonly runtime: FilesRuntime) {}

  @Get()
  async page(@Query() query: unknown, @Req() request: FilesRequest) {
    const roles = principalOf(request).roles
    // Files holds no roles (ADR 0060): its log is the workspace administrators' to read.
    if (!roles.some((role) => role.module === 'identity' && ['owner', 'admin'].includes(role.role)))
      throw new ForbiddenException('Reading the audit log takes the Identity owner or admin role')
    const parsed = auditQuerySchema.safeParse(query)
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid audit query')
    const filter = parsed.data
    return this.runtime.database.auditPage(principalOf(request).tenantId, {
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
