import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { ACTIVITY_KINDS, SUBJECT_TYPES } from '@/domain/value-objects/record-values'
import { CrmRuntime } from '@/main/crm-runtime'
import { actorOf, type CrmRequest, permits, RequireCrmAction, tenantOf } from './authorization'
import { context, idempotent, pageOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const subject = z.strictObject({ type: z.enum(SUBJECT_TYPES), id: z.uuid() })
const instant = z.string().max(40)
const activityFields = {
  kind: z.enum(ACTIVITY_KINDS),
  occurredAt: instant,
  title: z.string().max(200),
  summary: z.string().max(5000).nullish(),
  contactIds: z.array(z.uuid()).max(20).optional(),
}
const taskFields = {
  title: z.string().max(200),
  dueAt: instant,
  remindAt: instant.nullish(),
}
const noteBody = z.strictObject({ body: z.string().max(12_000) })
const taskQuery = z.object({
  assigneeId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  status: z.enum(['open', 'completed', 'cancelled']).optional(),
  dueBefore: z.iso.datetime({ offset: true }).optional(),
})
const agendaQuery = z.object({ until: z.iso.datetime({ offset: true }).optional() })
const DAY_MS = 24 * 60 * 60 * 1000

/** Assigning work to someone else is a manager's call; assigning it to yourself is not. */
function assertMayAssign(request: CrmRequest, assigneeId: string): void {
  if (assigneeId !== actorOf(request) && !permits(request.principal?.roles ?? [], 'assign'))
    throw new ForbiddenException('The CRM role does not permit assigning tasks to others')
}

/** Activities, tasks and notes around an account, my agenda and the timelines (Phase 57). */
@Controller()
export class RecordsController {
  constructor(@Inject(CrmRuntime) private readonly runtime: CrmRuntime) {}

  @Post('activities')
  @RequireCrmAction('write')
  async recordActivity(@Body() body: unknown, @Req() request: CrmRequest) {
    const { subject: about, ...activity } = parse(
      z.strictObject({ subject, ...activityFields }),
      body,
    )
    return unwrap(
      await this.runtime.recordActivity.execute({
        context: idempotent(request),
        subject: about,
        activity,
      }),
    )
  }

  @Get('activities/:id')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async activity(@Param('id') activityId: string, @Req() request: CrmRequest) {
    const found = await this.runtime.database.activityDetail(tenantOf(request), id(activityId))
    if (!found) throw new NotFoundException('Activity was not found')
    return found
  }

  @Put('activities/:id')
  @RequireCrmAction('write')
  async reviseActivity(
    @Param('id') activityId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return unwrap(
      await this.runtime.reviseActivity.execute({
        context: context(request),
        activityId: id(activityId),
        activity: parse(z.strictObject(activityFields), body),
      }),
    )
  }

  @Get('tasks')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async tasks(@Query() query: unknown, @Req() request: CrmRequest) {
    const filter = parse(taskQuery, query)
    const page = pageOf(query)
    const result = await this.runtime.database.listTasks(
      tenantOf(request),
      {
        assigneeId: filter.assigneeId ?? null,
        accountId: filter.accountId ?? null,
        status: filter.status ?? null,
        dueBefore: filter.dueBefore ? new Date(filter.dueBefore) : null,
        ...page,
      },
      this.runtime.clock.now(),
    )
    return { data: result.data, page: { ...page, total: result.total } }
  }

  @Get('tasks/:id')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async task(@Param('id') taskId: string, @Req() request: CrmRequest) {
    const found = await this.runtime.database.taskDetail(
      tenantOf(request),
      id(taskId),
      this.runtime.clock.now(),
    )
    if (!found) throw new NotFoundException('Task was not found')
    return found
  }

  @Post('tasks')
  @RequireCrmAction('write')
  async createTask(@Body() body: unknown, @Req() request: CrmRequest) {
    const {
      subject: about,
      assigneeId,
      ...task
    } = parse(z.strictObject({ subject, assigneeId: z.uuid(), ...taskFields }), body)
    assertMayAssign(request, assigneeId)
    return unwrap(
      await this.runtime.createTask.execute({
        context: idempotent(request),
        subject: about,
        assigneeId,
        task,
      }),
    )
  }

  @Put('tasks/:id')
  @RequireCrmAction('write')
  async reviseTask(@Param('id') taskId: string, @Body() body: unknown, @Req() request: CrmRequest) {
    const revised = unwrap(
      await this.runtime.changeTask.revise({
        context: context(request),
        taskId: id(taskId),
        task: parse(z.strictObject(taskFields), body),
      }),
    )
    return { revised }
  }

  @Post('tasks/:id/assignee')
  @RequireCrmAction('write')
  @HttpCode(204)
  async reassignTask(
    @Param('id') taskId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    const { assigneeId } = parse(z.strictObject({ assigneeId: z.uuid() }), body)
    assertMayAssign(request, assigneeId)
    unwrap(
      await this.runtime.changeTask.reassign({
        context: context(request),
        taskId: id(taskId),
        assigneeId,
      }),
    )
  }

  @Post('tasks/:id/complete')
  @RequireCrmAction('write')
  @HttpCode(204)
  async completeTask(@Param('id') taskId: string, @Req() request: CrmRequest) {
    unwrap(
      await this.runtime.changeTask.complete({ context: context(request), taskId: id(taskId) }),
    )
  }

  @Post('tasks/:id/cancel')
  @RequireCrmAction('write')
  @HttpCode(204)
  async cancelTask(@Param('id') taskId: string, @Req() request: CrmRequest) {
    unwrap(await this.runtime.changeTask.cancel({ context: context(request), taskId: id(taskId) }))
  }

  /** The caller's open tasks due up to `until` (default: the next 24 hours), overdue first. */
  @Get('agenda')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async agenda(@Query() query: unknown, @Req() request: CrmRequest) {
    const now = this.runtime.clock.now()
    const until = parse(agendaQuery, query).until
    const page = pageOf(query)
    const me = z.uuid().safeParse(actorOf(request))
    if (!me.success) return { data: [], page: { ...page, total: 0 } }
    const result = await this.runtime.database.listTasks(
      tenantOf(request),
      {
        assigneeId: me.data,
        accountId: null,
        status: 'open',
        dueBefore: until ? new Date(until) : new Date(now.getTime() + DAY_MS),
        ...page,
      },
      now,
    )
    return { data: result.data, page: { ...page, total: result.total } }
  }

  @Post('notes')
  @RequireCrmAction('write')
  async writeNote(@Body() body: unknown, @Req() request: CrmRequest) {
    const parsed = parse(z.strictObject({ subject, body: noteBody.shape.body }), body)
    return unwrap(
      await this.runtime.writeNote.execute({
        context: idempotent(request),
        subject: parsed.subject,
        body: parsed.body,
      }),
    )
  }

  @Get('notes/:id')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async note(@Param('id') noteId: string, @Req() request: CrmRequest) {
    const found = await this.runtime.database.noteDetail(tenantOf(request), id(noteId))
    if (!found) throw new NotFoundException('Note was not found')
    return found
  }

  @Post('notes/:id/revisions')
  @RequireCrmAction('write')
  async correctNote(
    @Param('id') noteId: string,
    @Body() body: unknown,
    @Req() request: CrmRequest,
  ) {
    return unwrap(
      await this.runtime.correctNote.execute({
        context: context(request),
        noteId: id(noteId),
        body: parse(noteBody, body).body,
      }),
    )
  }

  @Get('accounts/:id/timeline')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async accountTimeline(
    @Param('id') accountId: string,
    @Query() query: unknown,
    @Req() request: CrmRequest,
  ) {
    const tenantId = tenantOf(request)
    if (!(await this.runtime.database.accountDetail(tenantId, id(accountId))))
      throw new NotFoundException('Account was not found')
    return this.timeline(tenantId, { accountId }, query)
  }

  @Get('opportunities/:id/timeline')
  @RequireCrmAction('read')
  @Header('Cache-Control', 'no-store')
  async opportunityTimeline(
    @Param('id') opportunityId: string,
    @Query() query: unknown,
    @Req() request: CrmRequest,
  ) {
    const tenantId = tenantOf(request)
    if (!(await this.runtime.database.opportunityDetail(tenantId, id(opportunityId))))
      throw new NotFoundException('Opportunity was not found')
    return this.timeline(tenantId, { opportunityId }, query)
  }

  private async timeline(
    tenantId: string,
    scope: { accountId: string } | { opportunityId: string },
    query: unknown,
  ) {
    const page = pageOf(query)
    const result = await this.runtime.database.timeline(
      tenantId,
      scope,
      page,
      this.runtime.clock.now(),
    )
    return { data: result.data, page: { ...page, total: result.total } }
  }
}
