import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import type { PipelineChange } from '@/application/use-cases/manage-pipelines'
import type { ListKind } from '@/domain/value-objects/crm-values'
import { CrmRuntime } from '@/main/crm-runtime'
import { type CrmRequest, RequireCrmAction, tenantOf } from './authorization'
import { context, idempotent, pageOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const label = z.string().max(80)
const stage = z.strictObject({ name: label, probabilityBps: z.number().int() })
const money = z.strictObject({ amount: z.string().max(19), currency: z.string().length(3) })
const terms = {
  title: z.string().max(160),
  contactIds: z.array(z.uuid()).max(20).optional(),
  sourceId: z.uuid().nullable().optional(),
  expectedValue: money,
  expectedCloseOn: z.string().max(10),
}

const pipelineInput = z.strictObject({ name: label, stages: z.array(stage).min(1).max(30) })
const stageChange = z
  .strictObject({
    name: label.optional(),
    probabilityBps: z.number().int().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    'send at least one of name, probabilityBps, archived',
  )
const entryInput = z.strictObject({ name: label })
const entryChange = z
  .strictObject({ name: label.optional(), archived: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'send name or archived')
const includeArchived = z.object({ archived: z.enum(['include', 'exclude']).default('exclude') })
const opportunityInput = z.strictObject({
  accountId: z.uuid(),
  ownerId: z.uuid(),
  pipelineId: z.uuid(),
  stageId: z.uuid(),
  ...terms,
})
const opportunityQuery = z.object({
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  ownerId: z.uuid().optional(),
  accountId: z.uuid().optional(),
})

/** Pipelines, the source and loss-reason lists, and the opportunities that move through them. */
@Controller()
export class OpportunitiesController {
  constructor(@Inject(CrmRuntime) private readonly runtime: CrmRuntime) {}

  @Get('pipelines')
  @RequireCrmAction('read')
  async pipelines(@Query() query: unknown, @Req() request: CrmRequest) {
    const archived = parse(includeArchived, query).archived === 'include'
    return { data: await this.runtime.database.listPipelines(tenantOf(request), archived) }
  }

  @Get('pipelines/:id')
  @RequireCrmAction('read')
  async pipeline(@Param('id') pipelineId: string, @Req() request: CrmRequest) {
    const pipeline = await this.runtime.database.pipelineDetail(tenantOf(request), id(pipelineId))
    if (!pipeline) throw new NotFoundException('Pipeline was not found')
    return pipeline
  }

  @Post('pipelines')
  @RequireCrmAction('configure')
  async createPipeline(@Body() body: unknown, @Req() request: CrmRequest) {
    return unwrap(
      await this.runtime.createPipeline.execute({
        context: idempotent(request),
        ...parse(pipelineInput, body),
      }),
    )
  }

  @Put('pipelines/:id')
  @RequireCrmAction('configure')
  async renamePipeline(
    @Param('id') pipelineId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return this.change(request, pipelineId, { kind: 'rename', name: parse(entryInput, body).name })
  }

  @Patch('pipelines/:id/status')
  @RequireCrmAction('configure')
  async archivePipeline(
    @Param('id') pipelineId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const archived = parse(z.strictObject({ archived: z.boolean() }), body).archived
    return this.change(request, pipelineId, { kind: 'archive', archived })
  }

  @Post('pipelines/:id/stages')
  @RequireCrmAction('configure')
  async addStage(
    @Param('id') pipelineId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return this.change(request, pipelineId, { kind: 'add-stage', stage: parse(stage, body) })
  }

  @Patch('pipelines/:id/stages/:stageId')
  @RequireCrmAction('configure')
  async reviseStage(
    @Param('id') pipelineId: string,
    @Param('stageId') stageId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return this.change(request, pipelineId, {
      kind: 'revise-stage',
      stageId: id(stageId),
      ...parse(stageChange, body),
    })
  }

  @Put('pipelines/:id/stage-order')
  @RequireCrmAction('configure')
  async reorder(
    @Param('id') pipelineId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const { stageIds } = parse(z.strictObject({ stageIds: z.array(z.uuid()).min(1).max(60) }), body)
    return this.change(request, pipelineId, { kind: 'reorder', stageIds })
  }

  @Get('sources')
  @RequireCrmAction('read')
  sources(@Query() query: unknown, @Req() request: CrmRequest) {
    return this.entries('source', query, request)
  }

  @Post('sources')
  @RequireCrmAction('configure')
  createSource(@Body() body: unknown, @Req() request: CrmRequest) {
    return this.createEntry('source', body, request)
  }

  @Patch('sources/:id')
  @RequireCrmAction('configure')
  @HttpCode(204)
  changeSource(@Param('id') entryId: string, @Body() body: unknown, @Req() request: CrmRequest) {
    return this.changeEntry('source', entryId, body, request)
  }

  @Get('loss-reasons')
  @RequireCrmAction('read')
  lossReasons(@Query() query: unknown, @Req() request: CrmRequest) {
    return this.entries('loss-reason', query, request)
  }

  @Post('loss-reasons')
  @RequireCrmAction('configure')
  createLossReason(@Body() body: unknown, @Req() request: CrmRequest) {
    return this.createEntry('loss-reason', body, request)
  }

  @Patch('loss-reasons/:id')
  @RequireCrmAction('configure')
  @HttpCode(204)
  changeLossReason(
    @Param('id') entryId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return this.changeEntry('loss-reason', entryId, body, request)
  }

  @Get('opportunities')
  @RequireCrmAction('read')
  async opportunities(@Query() query: unknown, @Req() request: CrmRequest) {
    const filter = parse(opportunityQuery, query)
    const page = pageOf(query)
    const result = await this.runtime.database.listOpportunities(tenantOf(request), {
      pipelineId: filter.pipelineId ?? null,
      stageId: filter.stageId ?? null,
      status: filter.status ?? null,
      ownerId: filter.ownerId ?? null,
      accountId: filter.accountId ?? null,
      ...page,
    })
    return { data: result.data, page: { ...page, total: result.total } }
  }

  @Get('opportunities/:id')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async opportunity(@Param('id') opportunityId: string, @Req() request: CrmRequest) {
    const detail = await this.runtime.database.opportunityDetail(
      tenantOf(request),
      id(opportunityId),
    )
    if (!detail) throw new NotFoundException('Opportunity was not found')
    return { ...detail.opportunity, history: detail.history }
  }

  @Post('opportunities')
  @RequireCrmAction('write')
  async createOpportunity(@Body() body: unknown, @Req() request: CrmRequest) {
    const { accountId, ownerId, pipelineId, stageId, ...input } = parse(opportunityInput, body)
    return unwrap(
      await this.runtime.createOpportunity.execute({
        context: idempotent(request),
        accountId,
        ownerId,
        pipelineId,
        stageId,
        terms: input,
      }),
    )
  }

  @Put('opportunities/:id')
  @RequireCrmAction('write')
  async reviseOpportunity(
    @Param('id') opportunityId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const revised = unwrap(
      await this.runtime.changeOpportunity.revise({
        context: context(request),
        opportunityId: id(opportunityId),
        terms: parse(z.strictObject(terms), body),
      }),
    )
    return { revised }
  }

  @Post('opportunities/:id/stage')
  @RequireCrmAction('write')
  @HttpCode(204)
  async move(
    @Param('id') opportunityId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const { stageId } = parse(z.strictObject({ stageId: z.uuid() }), body)
    unwrap(
      await this.runtime.changeOpportunity.move({
        context: context(request),
        opportunityId: id(opportunityId),
        stageId,
      }),
    )
  }

  @Post('opportunities/:id/owner')
  @RequireCrmAction('assign')
  @HttpCode(204)
  async reassign(
    @Param('id') opportunityId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const { ownerId } = parse(z.strictObject({ ownerId: z.uuid() }), body)
    unwrap(
      await this.runtime.changeOpportunity.reassign({
        context: context(request),
        opportunityId: id(opportunityId),
        ownerId,
      }),
    )
  }

  @Post('opportunities/:id/win')
  @RequireCrmAction('write')
  @HttpCode(204)
  async win(@Param('id') opportunityId: string, @Req() request: CrmRequest) {
    unwrap(
      await this.runtime.changeOpportunity.win({
        context: context(request),
        opportunityId: id(opportunityId),
      }),
    )
  }

  @Post('opportunities/:id/lose')
  @RequireCrmAction('write')
  @HttpCode(204)
  async lose(
    @Param('id') opportunityId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const { lossReasonId, note } = parse(
      z.strictObject({ lossReasonId: z.uuid(), note: z.string().max(500).nullish() }),
      body,
    )
    unwrap(
      await this.runtime.changeOpportunity.lose({
        context: context(request),
        opportunityId: id(opportunityId),
        lossReasonId,
        note,
      }),
    )
  }

  @Post('opportunities/:id/reopen')
  @RequireCrmAction('write')
  @HttpCode(204)
  async reopen(
    @Param('id') opportunityId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const { stageId } = parse(z.strictObject({ stageId: z.uuid() }), body)
    unwrap(
      await this.runtime.changeOpportunity.reopen({
        context: context(request),
        opportunityId: id(opportunityId),
        stageId,
      }),
    )
  }

  private async change(request: CrmRequest, pipelineId: string, change: PipelineChange) {
    return unwrap(
      await this.runtime.changePipeline.execute({
        context: context(request),
        pipelineId: id(pipelineId),
        change,
      }),
    )
  }

  private async entries(kind: ListKind, query: unknown, request: CrmRequest) {
    const archived = parse(includeArchived, query).archived === 'include'
    return { data: await this.runtime.database.listEntries(tenantOf(request), kind, archived) }
  }

  private async createEntry(kind: ListKind, body: unknown, request: CrmRequest) {
    return unwrap(
      await this.runtime.createListEntry.execute({
        context: idempotent(request),
        kind,
        name: parse(entryInput, body).name,
      }),
    )
  }

  private async changeEntry(kind: ListKind, entryId: string, body: unknown, request: CrmRequest) {
    unwrap(
      await this.runtime.changeListEntry.execute({
        context: context(request),
        kind,
        entryId: id(entryId),
        ...parse(entryChange, body),
      }),
    )
  }
}
