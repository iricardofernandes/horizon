import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import type { CommandContext, IdempotentContext } from '@/application/use-cases/receivable-inputs'
import { MAX_TITLE_INSTALLMENTS } from '@/domain/entities/title'
import { RECEIVABLE_VIEWS } from '@/infrastructure/database/drizzle/receivable-reads'
import { FinancialRuntime } from '@/main/financial-runtime'
import { actorOf, type FinancialRequest, RequireFinancialAction, tenantOf } from './authorization'
import { id, parse, unwrap } from './request-parsing'

const minorUnits = z.string().regex(/^\d{1,18}$/)
const businessDate = z.iso.date()
const percentage = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/)
const reasonInput = z.strictObject({ reason: z.string().trim().min(3).max(500) })

const termsInput = z.strictObject({
  partyId: z.uuid(),
  documentNumber: z.string().trim().min(1).max(40),
  description: z.string().max(500).optional(),
  currency: z.string().length(3),
  categoryId: z.uuid().nullable().optional(),
  issuedOn: businessDate,
  competenceOn: businessDate.optional(),
  installments: z
    .array(z.strictObject({ dueOn: businessDate, amount: minorUnits }))
    .min(1)
    .max(MAX_TITLE_INSTALLMENTS),
  allocations: z
    .array(z.strictObject({ dimensionId: z.uuid(), percentage }))
    .max(50)
    .optional(),
})

const settlementInput = z.strictObject({
  installmentNumber: z.number().int().min(1).max(MAX_TITLE_INSTALLMENTS),
  settledOn: businessDate,
  received: minorUnits,
  discount: minorUnits.optional(),
  interest: minorUnits.optional(),
  penalty: minorUnits.optional(),
  paymentMethodId: z.uuid().nullable().optional(),
})

const listQuery = z.object({
  view: z.enum(RECEIVABLE_VIEWS).default('all'),
  search: z.string().max(100).optional(),
  partyId: z.uuid().optional(),
  today: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/

function today(value: unknown): string {
  return parse(businessDate.optional(), value) ?? new Date().toISOString().slice(0, 10)
}

function context(request: FinancialRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

/** Money-moving commands require a key, so a retried request never moves money twice (ADR 0028). */
function idempotent(request: FinancialRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...context(request), idempotencyKey: key }
}

@Controller('receivables')
export class ReceivablesController {
  constructor(@Inject(FinancialRuntime) private readonly runtime: FinancialRuntime) {}

  @Get()
  @RequireFinancialAction('read')
  async list(@Query() query: unknown, @Req() request: FinancialRequest) {
    const input = parse(listQuery, query)
    const page = await this.runtime.database.listReceivables(tenantOf(request), {
      ...input,
      today: input.today ?? today(undefined),
    })
    return { data: page.data, total: page.total, limit: input.limit, offset: input.offset }
  }

  /** Aging and totals at the caller's date. */
  @Get('summary')
  @RequireFinancialAction('read')
  async summary(@Query('today') date: unknown, @Req() request: FinancialRequest) {
    return this.runtime.database.receivablesSummary(tenantOf(request), today(date))
  }

  /** Customers a receivable may name, as the parties registry last described them. */
  @Get('customers')
  @RequireFinancialAction('read')
  async customers(@Req() request: FinancialRequest) {
    return { data: await this.runtime.database.listCustomers(tenantOf(request)) }
  }

  @Get(':id')
  @RequireFinancialAction('read')
  async detail(
    @Param('id') titleId: string,
    @Query('today') date: unknown,
    @Req() request: FinancialRequest,
  ) {
    const found = await this.runtime.database.receivableDetail(
      tenantOf(request),
      id(titleId),
      today(date),
    )
    if (!found) throw new NotFoundException('receivable was not found')
    return found
  }

  @Post()
  @RequireFinancialAction('record')
  async draft(@Body() body: unknown, @Req() request: FinancialRequest) {
    return unwrap(
      await this.runtime.draftReceivable.execute({
        context: idempotent(request),
        terms: parse(termsInput, body),
      }),
    )
  }

  @Put(':id')
  @RequireFinancialAction('record')
  @HttpCode(204)
  async revise(
    @Param('id') titleId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    unwrap(
      await this.runtime.reviseReceivable.execute({
        context: context(request),
        titleId: id(titleId),
        terms: parse(termsInput, body),
      }),
    )
  }

  @Post(':id/post')
  @RequireFinancialAction('record')
  @HttpCode(200)
  async post(@Param('id') titleId: string, @Req() request: FinancialRequest) {
    return unwrap(
      await this.runtime.postReceivable.execute({
        context: idempotent(request),
        titleId: id(titleId),
      }),
    )
  }

  @Post(':id/cancel')
  @RequireFinancialAction('record')
  @HttpCode(204)
  async cancel(
    @Param('id') titleId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    unwrap(
      await this.runtime.cancelReceivable.execute({
        context: context(request),
        titleId: id(titleId),
        reason: parse(reasonInput, body).reason,
      }),
    )
  }

  @Post(':id/reverse')
  @RequireFinancialAction('reverse')
  @HttpCode(200)
  async reverse(
    @Param('id') titleId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    return unwrap(
      await this.runtime.reverseReceivable.execute({
        context: idempotent(request),
        titleId: id(titleId),
        reason: parse(reasonInput, body).reason,
      }),
    )
  }

  @Post(':id/settlements')
  @RequireFinancialAction('record')
  async settle(
    @Param('id') titleId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    return unwrap(
      await this.runtime.recordSettlement.execute({
        context: idempotent(request),
        titleId: id(titleId),
        settlement: parse(settlementInput, body),
      }),
    )
  }

  @Post(':id/settlements/:settlementId/reverse')
  @RequireFinancialAction('reverse')
  @HttpCode(200)
  async reverseSettlement(
    @Param('id') titleId: string,
    @Param('settlementId') settlementId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    return unwrap(
      await this.runtime.reverseSettlement.execute({
        context: idempotent(request),
        titleId: id(titleId),
        settlementId: id(settlementId),
        reason: parse(reasonInput, body).reason,
      }),
    )
  }
}
