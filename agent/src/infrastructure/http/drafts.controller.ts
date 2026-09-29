import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { AgentRuntime } from '@/main/agent-runtime'
import { type AgentRequest, principalOf } from './authorization'

const draftsQuery = z.strictObject({
  module: z.enum(['sales', 'procurement', 'financial', 'crm']),
  type: z
    .string()
    .regex(/^[a-z-]{2,40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

/**
 * Which records of a module the tenant's agents drafted (ADR 0066), for the lists to mark.
 * Ids only, and only to a person who holds a role in that module: they read the records
 * themselves from the module, which decides what they may see.
 */
@Controller('drafts')
export class DraftsController {
  constructor(@Inject(AgentRuntime) private readonly runtime: AgentRuntime) {}

  @Get()
  async list(@Query() query: unknown, @Req() request: AgentRequest) {
    const parsed = draftsQuery.safeParse(query)
    if (!parsed.success)
      throw new BadRequestException('Send module=sales|procurement|financial|crm')
    const principal = principalOf(request)
    if (!principal.roles.some((role) => role.module === parsed.data.module))
      throw new ForbiddenException(`This takes a ${parsed.data.module} role`)
    return {
      data: await this.runtime.database.drafts(
        principal.tenantId,
        parsed.data.module,
        parsed.data.type,
        parsed.data.limit,
      ),
    }
  }
}
