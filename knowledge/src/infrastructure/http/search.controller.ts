import { BadRequestException, Controller, Get, Header, Inject, Query, Req } from '@nestjs/common'
import { z } from 'zod'
import { MAX_RESULTS } from '@/application/search'
import { ATTACHING_MODULES } from '@/domain/readers'
import { KnowledgeRuntime } from '@/main/knowledge-runtime'
import { type KnowledgeRequest, principalOf } from './authorization'

export const SEARCH_MAX_LENGTH = 200

const searchQuery = z
  .strictObject({
    q: z.string().trim().min(2).max(SEARCH_MAX_LENGTH),
    limit: z.coerce.number().int().min(1).max(MAX_RESULTS).optional(),
    module: z.enum(ATTACHING_MODULES).optional(),
    recordType: z
      .string()
      .regex(/^[a-z-]{2,40}$/)
      .optional(),
    recordId: z.uuid().optional(),
  })
  .refine(
    (query) =>
      [query.module, query.recordType, query.recordId].every((value) => value === undefined) ||
      [query.module, query.recordType, query.recordId].every((value) => value !== undefined),
    { message: 'module, recordType and recordId go together' },
  )

/**
 * Search the workspace's attachments by meaning and by words (Phase 75). The caller's own
 * roles decide which modules are searched; every result cites its attachment and record.
 * The question is never logged.
 */
@Controller('search')
export class SearchController {
  constructor(@Inject(KnowledgeRuntime) private readonly runtime: KnowledgeRuntime) {}

  @Get()
  @Header('cache-control', 'private, no-store')
  async search(@Query() query: unknown, @Req() request: KnowledgeRequest) {
    const parsed = searchQuery.safeParse(query)
    if (!parsed.success)
      throw new BadRequestException(
        `Send q (2 to ${SEARCH_MAX_LENGTH} characters), and optionally limit, or module, recordType and recordId together`,
      )
    const principal = principalOf(request)
    const { q, limit, module, recordType, recordId } = parsed.data
    return this.runtime.search.search(
      {
        tenantId: principal.tenantId,
        roles: principal.roles,
        ...(principal.scopes ? { scopes: principal.scopes } : {}),
      },
      {
        text: q,
        ...(limit ? { limit } : {}),
        ...(module && recordType && recordId ? { record: { module, recordType, recordId } } : {}),
      },
    )
  }
}
