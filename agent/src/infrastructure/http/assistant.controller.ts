import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { NOTICE_VERSION, type Person, QUESTION_MAX } from '@/application/assistant'
import { monthOf } from '@/domain/answers'
import { AgentRuntime } from '@/main/agent-runtime'
import { type AgentRequest, principalOf, requireWorkspaceRole } from './authorization'

const question = z.strictObject({
  question: z.string().trim().min(2).max(QUESTION_MAX),
  conversationId: z.uuid().optional(),
})

const settingsChange = z
  .strictObject({
    enabled: z.boolean().optional(),
    acceptNotice: z.string().max(64).optional(),
    monthlyBudgetTokens: z.number().int().min(1000).max(50_000_000).optional(),
  })
  .refine((change) => Object.keys(change).length > 0)

const holds = (request: AgentRequest, role: string) =>
  principalOf(request).roles.some((held) => held.module === 'identity' && held.role === role)

/**
 * The in-app assistant (Phase 76): only a signed-in person reaches it, and every tool it
 * calls carries that person's own token. A key's token is refused by the guard.
 */
@Controller('assistant')
export class AssistantController {
  constructor(@Inject(AgentRuntime) private readonly runtime: AgentRuntime) {}

  private person(request: AgentRequest): Person {
    const principal = principalOf(request)
    const authorization = request.headers.authorization
    return {
      tenantId: principal.tenantId,
      userId: principal.subject,
      roles: principal.roles,
      accessToken: typeof authorization === 'string' ? authorization.slice(7) : '',
    }
  }

  /** What the screen needs to say: on or off, whether a provider is there, and the month. */
  @Get('status')
  @Header('cache-control', 'private, no-store')
  async status(@Req() request: AgentRequest) {
    const { tenantId } = principalOf(request)
    const month = monthOf(this.runtime.clock.now())
    const [settings, usage] = await Promise.all([
      this.runtime.assistantDatabase.settings(tenantId),
      this.runtime.assistantDatabase.usage(tenantId, month),
    ])
    return {
      enabled: settings.enabled,
      available: this.runtime.generator.available,
      provider: this.runtime.generator.provider,
      model: this.runtime.generator.model,
      notice: {
        version: NOTICE_VERSION,
        accepted: settings.noticeVersion === NOTICE_VERSION,
        acceptedBy: settings.acceptedBy,
        acceptedAt: settings.acceptedAt?.toISOString() ?? null,
      },
      budget: {
        month,
        monthlyTokens: settings.monthlyBudgetTokens,
        spentTokens: usage.inputTokens + usage.outputTokens,
        questions: usage.questions,
      },
    }
  }

  /**
   * Only an owner turns it on, and only by accepting the current notice; an owner or admin
   * turns it off or sets the budget.
   */
  @Put('settings')
  async settings(@Body() body: unknown, @Req() request: AgentRequest) {
    requireWorkspaceRole(request, ['owner', 'admin'])
    const parsed = settingsChange.safeParse(body)
    if (!parsed.success)
      throw new BadRequestException(
        'Send enabled, acceptNotice and/or monthlyBudgetTokens (1000 to 50000000)',
      )
    const principal = principalOf(request)
    const change = parsed.data
    if (change.acceptNotice !== undefined && change.acceptNotice !== NOTICE_VERSION)
      throw new BadRequestException(`The current notice is ${NOTICE_VERSION}`)
    if (change.enabled === true || change.acceptNotice !== undefined) {
      if (!holds(request, 'owner'))
        throw new ForbiddenException('Only a workspace owner turns the assistant on')
      const current = await this.runtime.assistantDatabase.settings(principal.tenantId)
      if (
        change.enabled === true &&
        change.acceptNotice === undefined &&
        current.noticeVersion !== NOTICE_VERSION
      )
        throw new ForbiddenException(`Accept the notice ${NOTICE_VERSION} to turn the assistant on`)
    }
    await this.runtime.assistantDatabase.changeSettings(
      principal.tenantId,
      {
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.acceptNotice === undefined ? {} : { noticeVersion: change.acceptNotice }),
        ...(change.monthlyBudgetTokens === undefined
          ? {}
          : { monthlyBudgetTokens: change.monthlyBudgetTokens }),
      },
      principal.subject,
      this.runtime.clock.now(),
    )
    return this.status(request)
  }

  @Post('questions')
  @Header('cache-control', 'private, no-store')
  async ask(@Body() body: unknown, @Req() request: AgentRequest) {
    const parsed = question.safeParse(body)
    if (!parsed.success)
      throw new BadRequestException(`Send a question of 2 to ${QUESTION_MAX} characters`)
    const result = await this.runtime.assistant.ask(this.person(request), {
      question: parsed.data.question,
      ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
    })
    if (!result.ok)
      throw new HttpException({ code: result.code, message: result.detail }, result.status)
    return result.answer
  }

  @Get('conversations')
  @Header('cache-control', 'private, no-store')
  async conversations(@Req() request: AgentRequest) {
    return { data: await this.runtime.assistant.list(this.person(request)) }
  }

  @Get('conversations/:id')
  @Header('cache-control', 'private, no-store')
  async conversation(@Param('id') id: string, @Req() request: AgentRequest) {
    const conversationId = z.uuid().safeParse(id)
    if (!conversationId.success) throw new NotFoundException()
    const turns = await this.runtime.assistant.turns(this.person(request), conversationId.data)
    if (!turns) throw new NotFoundException('No such conversation')
    return { id: conversationId.data, turns }
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() request: AgentRequest) {
    const conversationId = z.uuid().safeParse(id)
    const person = this.person(request)
    if (
      !conversationId.success ||
      !(await this.runtime.assistantDatabase.deleteConversation(
        person.tenantId,
        person.userId,
        conversationId.data,
      ))
    )
      throw new NotFoundException()
  }
}
