import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { SUGGESTION_KINDS, type SuggestionKind } from '@/domain/suggestions'
import { KnowledgeRuntime } from '@/main/knowledge-runtime'
import { type KnowledgeRequest, principalOf } from './authorization'

/** Who may see a kind's history: the roles that read the records it comes from. */
const READERS: Readonly<Record<SuggestionKind, { module: string; roles: readonly string[] }>> = {
  ncm: { module: 'catalog', roles: ['admin', 'editor', 'viewer'] },
  'payable-category': { module: 'financial', roles: ['admin', 'operator', 'viewer'] },
}

const text = z.string().trim().min(2).max(500)
const ncmQuery = z.strictObject({ text })
const categoryQuery = z.strictObject({ text, partyId: z.uuid().optional() })
const decision = z.strictObject({
  kind: z.enum(SUGGESTION_KINDS),
  decision: z.enum(['accepted', 'rejected']),
  rank: z.number().int().min(1).max(3).optional(),
})

function requireReader(request: KnowledgeRequest, kind: SuggestionKind): string {
  const principal = principalOf(request)
  const { module, roles } = READERS[kind]
  if (!principal.roles.some((held) => held.module === module && roles.includes(held.role)))
    throw new ForbiddenException(`This takes a ${module} read role`)
  return principal.tenantId
}

/**
 * Suggestions while a person fills a form (Phase 77). They read only the caller's own
 * workspace's history and the public table, and never write; a decision is only counted.
 */
@Controller('suggestions')
export class SuggestionsController {
  constructor(@Inject(KnowledgeRuntime) private readonly runtime: KnowledgeRuntime) {}

  @Get('ncm')
  @Header('cache-control', 'private, no-store')
  ncm(@Query() query: unknown, @Req() request: KnowledgeRequest) {
    const parsed = ncmQuery.safeParse(query)
    if (!parsed.success)
      throw new BadRequestException('Send text: the item name, 2 to 500 characters')
    return this.runtime.suggestions.suggest(requireReader(request, 'ncm'), 'ncm', parsed.data.text)
  }

  @Get('payable-category')
  @Header('cache-control', 'private, no-store')
  payableCategory(@Query() query: unknown, @Req() request: KnowledgeRequest) {
    const parsed = categoryQuery.safeParse(query)
    if (!parsed.success)
      throw new BadRequestException('Send text (2 to 500 characters) and, optionally, partyId')
    return this.runtime.suggestions.suggest(
      requireReader(request, 'payable-category'),
      'payable-category',
      parsed.data.text,
      parsed.data.partyId,
    )
  }

  /** Accepted or rejected: counted as a metric, and nothing else is kept. */
  @Post('decisions')
  @HttpCode(204)
  decide(@Body() body: unknown, @Req() request: KnowledgeRequest) {
    const parsed = decision.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Send kind and decision')
    requireReader(request, parsed.data.kind)
    this.runtime.suggestions.decide(parsed.data.kind, parsed.data.decision)
  }
}
