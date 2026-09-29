import { auditQuerySchema } from '@horizon/contracts'
import { BadRequestException, Controller, Get, Inject, Query, Req } from '@nestjs/common'
import { AgentRuntime } from '@/main/agent-runtime'
import { type AgentRequest, principalOf, requireWorkspaceRole } from './authorization'

/** Every agent call and every switch, a page at a time, with the chain's verdict (Phase 68). */
@Controller('audit')
export class AuditController {
  constructor(@Inject(AgentRuntime) private readonly runtime: AgentRuntime) {}

  @Get()
  async page(@Query() query: unknown, @Req() request: AgentRequest) {
    requireWorkspaceRole(request, ['owner', 'admin', 'auditor'])
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
