import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common'
import { z } from 'zod'
import { STATEMENT_FORMATS } from '@/application/ports/statement-adapter'
import { TreasuryRuntime } from '@/main/treasury-runtime'
import { RequireTreasuryAction, type TreasuryRequest, tenantOf } from './authorization'
import { businessDate, context, idempotent, rangeOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

/** Two megabytes of statement text; larger files are split by period. */
export const MAX_STATEMENT_CHARACTERS = 2_000_000

const reason = z.string().trim().min(3).max(500)
const minorUnits = z.string().regex(/^\d{1,18}$/)
const pick = z.strictObject({ id: z.uuid(), amount: minorUnits.optional() })

const importInput = z.strictObject({
  format: z.enum(STATEMENT_FORMATS),
  fileName: z.string().trim().min(1).max(255),
  content: z.string().min(1).max(MAX_STATEMENT_CHARACTERS),
})
const matchInput = z.strictObject({
  statementLines: z.array(pick).min(1).max(50),
  entries: z.array(pick).max(50),
  adjustment: z
    .strictObject({ valueOn: businessDate, memo: z.string().max(200).optional() })
    .optional(),
  suggestionKey: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
})
const ignoreInput = z.strictObject({ statementLines: z.array(pick).min(1).max(50), reason })
const dismissInput = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{32}$/),
  score: z.number().int().min(0).max(100),
})

@Controller()
export class ReconciliationController {
  constructor(@Inject(TreasuryRuntime) private readonly runtime: TreasuryRuntime) {}

  @Post('accounts/:id/statements')
  @RequireTreasuryAction('record')
  async import(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.importStatement.execute({
        context: idempotent(request),
        accountId: id(accountId),
        ...parse(importInput, body),
      }),
    )
  }

  /** Bank lines and entries side by side, with suggestions and the period summary. */
  @Get('accounts/:id/reconciliation')
  @RequireTreasuryAction('read')
  async workspace(
    @Param('id') accountId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: TreasuryRequest,
  ) {
    return this.runtime.database.reconciliationWorkspace(
      tenantOf(request),
      id(accountId),
      rangeOf({ from: query.from, to: query.to }),
    )
  }

  @Get('accounts/:id/reconciliation/metrics')
  @RequireTreasuryAction('read')
  async metrics(@Param('id') accountId: string, @Req() request: TreasuryRequest) {
    return this.runtime.database.reconciliationMetrics(tenantOf(request), id(accountId))
  }

  @Post('accounts/:id/reconciliations')
  @RequireTreasuryAction('record')
  async match(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.confirmMatch.execute({
        context: idempotent(request),
        accountId: id(accountId),
        ...parse(matchInput, body),
      }),
    )
  }

  @Post('accounts/:id/reconciliations/ignore')
  @RequireTreasuryAction('record')
  async ignore(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.ignoreLines.execute({
        context: idempotent(request),
        accountId: id(accountId),
        ...parse(ignoreInput, body),
      }),
    )
  }

  @Post('reconciliations/:id/undo')
  @RequireTreasuryAction('reverse')
  @HttpCode(200)
  async undo(
    @Param('id') reconciliationId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.undoReconciliation.execute({
        context: idempotent(request),
        reconciliationId: id(reconciliationId),
        reason: parse(z.strictObject({ reason }), body).reason,
      }),
    )
  }

  @Post('accounts/:id/suggestions/dismiss')
  @RequireTreasuryAction('record')
  @HttpCode(204)
  async dismiss(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    unwrap(
      await this.runtime.dismissSuggestion.execute({
        context: context(request),
        accountId: id(accountId),
        ...parse(dismissInput, body),
      }),
    )
  }

  @Post('accounts/:id/reconciliation/close')
  @RequireTreasuryAction('configure')
  @HttpCode(200)
  async close(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.closePeriod.execute({
        context: idempotent(request),
        accountId: id(accountId),
        through: parse(z.strictObject({ through: businessDate }), body).through,
      }),
    )
  }

  @Post('accounts/:id/reconciliation/reopen')
  @RequireTreasuryAction('configure')
  @HttpCode(200)
  async reopen(
    @Param('id') accountId: string,
    @Body() body: unknown,
    @Req() request: TreasuryRequest,
  ) {
    return unwrap(
      await this.runtime.reopenPeriod.execute({
        context: idempotent(request),
        accountId: id(accountId),
        reason: parse(z.strictObject({ reason }), body).reason,
      }),
    )
  }
}
