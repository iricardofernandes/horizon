import {
  Body,
  Controller,
  Get,
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
import { POSTING_ROLES } from '@/domain/entities/account-mapping'
import { ACCOUNT_TYPES, ENTRY_SIDES } from '@/domain/entities/ledger-account'
import { LedgerRuntime } from '@/main/ledger-runtime'
import { type LedgerRequest, PublicRoute, RequireLedgerAction, tenantOf } from './authorization'
import { context, idempotent, rangeOf, today } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const minorUnits = z.string().regex(/^\d{1,18}$/)
const businessDate = z.iso.date()
const period = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)
const currency = z.string().length(3)
const reasonInput = z.strictObject({ reason: z.string().trim().min(3).max(500) })

const openAccountInput = z.strictObject({
  code: z.string().trim().min(1).max(23),
  name: z.string().trim().min(2).max(120),
  type: z.enum(ACCOUNT_TYPES),
  postable: z.boolean(),
  currency,
})

const transactionInput = z.strictObject({
  reference: z.string().trim().min(1).max(60),
  postedOn: businessDate,
  currency,
  memo: z.string().max(200).optional(),
  lines: z
    .array(
      z.strictObject({
        accountId: z.uuid(),
        side: z.enum(ENTRY_SIDES),
        amount: minorUnits,
        memo: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(200),
})

const mappingInput = z.strictObject({
  role: z.enum(POSTING_ROLES),
  key: z.uuid().nullable().default(null),
  accountId: z.uuid(),
})

const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})

@Controller()
export class LedgerController {
  constructor(@Inject(LedgerRuntime) private readonly runtime: LedgerRuntime) {}

  @Get('health/live')
  @PublicRoute()
  live() {
    return { status: 'ok' }
  }

  @Get('health/ready')
  @PublicRoute()
  async ready() {
    await this.runtime.database.ping()
    return { status: 'ok' }
  }

  /** The chart of accounts with each account's balance and its subtree's total. */
  @Get('accounts')
  @RequireLedgerAction('read')
  async accounts(@Query('asOf') asOf: unknown, @Req() request: LedgerRequest) {
    const date = parse(businessDate.optional(), asOf) ?? today()
    return {
      asOf: date,
      data: await this.runtime.database.chartOfAccounts(tenantOf(request), date),
    }
  }

  @Post('accounts')
  @RequireLedgerAction('configure')
  async open(@Body() body: unknown, @Req() request: LedgerRequest) {
    return unwrap(
      await this.runtime.openAccount.execute({
        context: idempotent(request),
        account: parse(openAccountInput, body),
      }),
    )
  }

  @Patch('accounts/:id/status')
  @RequireLedgerAction('configure')
  @HttpCode(204)
  async status(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: LedgerRequest,
  ) {
    unwrap(
      await this.runtime.changeAccountStatus.execute({
        context: context(request),
        accountId: id(accountId),
        active: parse(z.strictObject({ active: z.boolean() }), body).active,
      }),
    )
  }

  /** One account's lines between two dates, each with the balance it left behind. */
  @Get('accounts/:id/ledger')
  @RequireLedgerAction('read')
  async ledger(
    @Param('id') accountId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: LedgerRequest,
  ) {
    const range = rangeOf({ from: query.from, to: query.to })
    const paging = parse(page, { limit: query.limit, offset: query.offset })
    const found = await this.runtime.database.accountLedger(tenantOf(request), id(accountId), {
      ...range,
      ...paging,
    })
    if (!found) throw new NotFoundException('account was not found')
    return { ...range, ...found }
  }

  /** Opening, movement and closing per account: the report the ledger exists to produce. */
  @Get('trial-balance')
  @RequireLedgerAction('read')
  async trialBalance(@Query() query: Record<string, unknown>, @Req() request: LedgerRequest) {
    const range = rangeOf({ from: query.from, to: query.to })
    return this.runtime.database.trialBalance(tenantOf(request), range)
  }

  @Get('transactions')
  @RequireLedgerAction('read')
  async transactions(@Query() query: Record<string, unknown>, @Req() request: LedgerRequest) {
    const range = rangeOf({ from: query.from, to: query.to })
    const paging = parse(page, { limit: query.limit, offset: query.offset })
    return {
      ...range,
      ...(await this.runtime.database.listTransactions(tenantOf(request), {
        ...range,
        ...paging,
      })),
    }
  }

  @Post('transactions')
  @RequireLedgerAction('post')
  async postTransaction(@Body() body: unknown, @Req() request: LedgerRequest) {
    return unwrap(
      await this.runtime.postTransaction.execute({
        context: idempotent(request),
        transaction: parse(transactionInput, body),
      }),
    )
  }

  @Get('transactions/:id')
  @RequireLedgerAction('read')
  async transaction(@Param('id') transactionId: string, @Req() request: LedgerRequest) {
    const found = await this.runtime.database.transactionDetail(
      tenantOf(request),
      id(transactionId),
    )
    if (!found) throw new NotFoundException('transaction was not found')
    return found
  }

  @Post('transactions/:id/reverse')
  @RequireLedgerAction('reverse')
  @HttpCode(200)
  async reverse(
    @Param('id') transactionId: string,
    @Body() body: unknown,
    @Req() request: LedgerRequest,
  ) {
    const input = parse(
      z.strictObject({
        reason: z.string().trim().min(3).max(500),
        reversalOn: businessDate.optional(),
      }),
      body,
    )
    return unwrap(
      await this.runtime.reverseTransaction.execute({
        context: idempotent(request),
        transactionId: id(transactionId),
        reason: input.reason,
        reversalOn: input.reversalOn,
      }),
    )
  }

  /** Which of the workspace's accounts plays each part when another module reports a fact. */
  @Get('mappings')
  @RequireLedgerAction('read')
  async mappings(@Req() request: LedgerRequest) {
    return { data: await this.runtime.database.listMappings(tenantOf(request)) }
  }

  @Put('mappings')
  @RequireLedgerAction('configure')
  @HttpCode(200)
  async map(@Body() body: unknown, @Req() request: LedgerRequest) {
    return unwrap(
      await this.runtime.defineMapping.execute({
        context: context(request),
        ...parse(mappingInput, body),
      }),
    )
  }

  /** The facts the books are still missing, and why each one could not be posted. */
  @Get('postings/pending')
  @RequireLedgerAction('read')
  async pending(@Query('limit') limit: unknown, @Req() request: LedgerRequest) {
    const size = parse(z.coerce.number().int().min(1).max(500).default(100), limit)
    return this.runtime.database.listPendingFacts(tenantOf(request), size)
  }

  @Post('postings/pending/replay')
  @RequireLedgerAction('post')
  @HttpCode(200)
  async replay(@Req() request: LedgerRequest) {
    return unwrap(await this.runtime.replayPending.execute({ context: context(request) }))
  }

  @Get('periods')
  @RequireLedgerAction('read')
  async periods(@Query('limit') limit: unknown, @Req() request: LedgerRequest) {
    const size = parse(z.coerce.number().int().min(1).max(120).default(24), limit)
    return { data: await this.runtime.database.listPeriods(tenantOf(request), size) }
  }

  @Post('periods/:period/close')
  @RequireLedgerAction('close')
  @HttpCode(200)
  async close(@Param('period') month: string, @Req() request: LedgerRequest) {
    return unwrap(
      await this.runtime.closePeriod.execute({
        context: idempotent(request),
        period: parse(period, month),
      }),
    )
  }

  @Post('periods/:period/reopen')
  @RequireLedgerAction('close')
  @HttpCode(200)
  async reopen(
    @Param('period') month: string,
    @Body() body: unknown,
    @Req() request: LedgerRequest,
  ) {
    return unwrap(
      await this.runtime.reopenPeriod.execute({
        context: idempotent(request),
        period: parse(period, month),
        reason: parse(reasonInput, body).reason,
      }),
    )
  }
}
