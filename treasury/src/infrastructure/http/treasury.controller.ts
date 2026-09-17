import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import type { CommandContext, IdempotentContext } from '@/application/use-cases/commands'
import { ACCOUNT_KINDS } from '@/domain/entities/account'
import { ENTRY_DIRECTIONS } from '@/domain/entities/journal-entry'
import { TreasuryRuntime } from '@/main/treasury-runtime'
import {
  actorOf,
  PublicRoute,
  RequireTreasuryAction,
  type TreasuryRequest,
  tenantOf,
} from './authorization'
import { id, parse, unwrap } from './request-parsing'

const minorUnits = z.string().regex(/^\d{1,18}$/)
const businessDate = z.iso.date()
const currency = z.string().length(3)
const reasonInput = z.strictObject({ reason: z.string().trim().min(3).max(500) })

const openAccountInput = z.strictObject({
  kind: z.enum(ACCOUNT_KINDS),
  name: z.string().trim().min(2).max(120),
  currency,
  bank: z
    .strictObject({
      bankCode: z.string().max(3),
      branch: z.string().max(10),
      accountNumber: z.string().max(20),
    })
    .optional(),
  openedOn: businessDate,
  openingBalance: z.strictObject({ amount: minorUnits, direction: z.enum(ENTRY_DIRECTIONS) }),
})

const entryInput = z.strictObject({
  direction: z.enum(ENTRY_DIRECTIONS),
  amount: minorUnits,
  currency,
  valueOn: businessDate,
  counterparty: z.string().max(200).optional(),
  memo: z.string().max(200).optional(),
})

const transferInput = z.strictObject({
  fromAccountId: z.uuid(),
  toAccountId: z.uuid(),
  amount: minorUnits,
  fee: minorUnits.optional(),
  currency,
  valueOn: businessDate,
  memo: z.string().max(200).optional(),
})

const MAX_RANGE_DAYS = 366
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

/** A bounded value-date range; the default is the last thirty days up to today. */
function rangeOf(query: unknown): { from: string; to: string } {
  const input = parse(
    z.object({ from: businessDate.optional(), to: businessDate.optional() }),
    query,
  )
  const to = input.to ?? today()
  const from = input.from ?? daysBefore(to, 30)
  if (from > to) throw new BadRequestException('from: must not be after to')
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000
  if (span > MAX_RANGE_DAYS)
    throw new BadRequestException(`the range may span at most ${MAX_RANGE_DAYS} days`)
  return { from, to }
}

function context(request: TreasuryRequest): CommandContext {
  const requestId = request.headers['x-request-id']
  return {
    tenantId: tenantOf(request),
    actor: actorOf(request),
    requestId: typeof requestId === 'string' ? requestId.slice(0, 128) : null,
  }
}

/** Money-moving commands require a key, so a retried request never moves money twice (ADR 0028). */
function idempotent(request: TreasuryRequest): IdempotentContext {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
    throw new BadRequestException(
      'Idempotency-Key header is required: 8 to 255 visible ASCII characters',
    )
  return { ...context(request), idempotencyKey: key }
}

@Controller()
export class TreasuryController {
  constructor(@Inject(TreasuryRuntime) private readonly runtime: TreasuryRuntime) {}

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

  /** Every account with its balances as of a calendar date (today by default). */
  @Get('accounts')
  @RequireTreasuryAction('read')
  async accounts(@Query('asOf') asOf: unknown, @Req() request: TreasuryRequest) {
    const date = parse(businessDate.optional(), asOf) ?? today()
    return { data: await this.runtime.database.listAccounts(tenantOf(request), date) }
  }

  @Post('accounts')
  @RequireTreasuryAction('configure')
  async open(@Body() body: unknown, @Req() request: TreasuryRequest) {
    return unwrap(
      await this.runtime.openAccount.execute({
        context: idempotent(request),
        account: parse(openAccountInput, body),
      }),
    )
  }

  @Get('accounts/:id')
  @RequireTreasuryAction('read')
  async account(
    @Param('id') accountId: string,
    @Query('asOf') asOf: unknown,
    @Req() request: TreasuryRequest,
  ) {
    const date = parse(businessDate.optional(), asOf) ?? today()
    const found = await this.runtime.database.accountBalances(
      tenantOf(request),
      id(accountId),
      date,
    )
    if (!found) throw new NotFoundException('account was not found')
    return found
  }

  @Patch('accounts/:id/status')
  @RequireTreasuryAction('configure')
  @HttpCode(204)
  async status(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    unwrap(
      await this.runtime.changeAccountStatus.execute({
        context: context(request),
        accountId: id(accountId),
        active: parse(z.strictObject({ active: z.boolean() }), body).active,
      }),
    )
  }

  /** The journal between two value dates, each line with the balance right after it. */
  @Get('accounts/:id/statement')
  @RequireTreasuryAction('read')
  async statement(
    @Param('id') accountId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: TreasuryRequest,
  ) {
    const { from, to } = rangeOf({ from: query.from, to: query.to })
    const page = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      }),
      { limit: query.limit, offset: query.offset },
    )
    return {
      from,
      to,
      ...(await this.runtime.database.accountStatement(tenantOf(request), id(accountId), {
        from,
        to,
        ...page,
      })),
    }
  }

  @Get('accounts/:id/timeline')
  @RequireTreasuryAction('read')
  async timeline(
    @Param('id') accountId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: TreasuryRequest,
  ) {
    const range = rangeOf({ from: query.from, to: query.to })
    return {
      ...range,
      data: await this.runtime.database.balanceTimeline(tenantOf(request), id(accountId), range),
    }
  }

  @Post('accounts/:id/entries')
  @RequireTreasuryAction('record')
  async record(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.recordEntry.execute({
        context: idempotent(request),
        accountId: id(accountId),
        entry: parse(entryInput, body),
      }),
    )
  }

  @Post('entries/:id/reverse')
  @RequireTreasuryAction('reverse')
  @HttpCode(200)
  async reverseEntry(
    @Param('id') entryId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.reverseEntry.execute({
        context: idempotent(request),
        entryId: id(entryId),
        reason: parse(reasonInput, body).reason,
      }),
    )
  }

  @Get('transfers')
  @RequireTreasuryAction('read')
  async transfers(@Query('limit') limit: unknown, @Req() request: TreasuryRequest) {
    const size = parse(z.coerce.number().int().min(1).max(200).default(50), limit)
    return { data: await this.runtime.database.listTransfers(tenantOf(request), size) }
  }

  @Post('transfers')
  @RequireTreasuryAction('record')
  async transfer(@Body() body: unknown, @Req() request: TreasuryRequest) {
    return unwrap(
      await this.runtime.postTransfer.execute({
        context: idempotent(request),
        transfer: parse(transferInput, body),
      }),
    )
  }

  @Post('transfers/:id/cancel')
  @RequireTreasuryAction('reverse')
  @HttpCode(200)
  async cancel(
    @Param('id') transferId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.cancelTransfer.execute({
        context: idempotent(request),
        transferId: id(transferId),
        reason: parse(reasonInput, body).reason,
      }),
    )
  }
}
