import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import type { ServiceContract } from '@/domain/entities/service-contract'
import { billedSnapshot, CREDIT_REASONS } from '@/domain/services/contract-billing'
import { RECURRENCES } from '@/domain/services/contract-schedule'
import { BusinessDate } from '@/domain/value-objects/sales-values'
import { SalesRuntime } from '@/main/sales-runtime'
import { RequireSalesAction, type SalesRequest, tenantOf } from './authorization'
import { context, idempotent } from './command-context'

const day = z.iso.date()
const reason = z.string().trim().min(1).max(500)
const contractLines = z
  .array(
    z.strictObject({
      lineId: z.uuid(),
      itemId: z.uuid(),
      quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
      unitPrice: z
        .string()
        .regex(/^\d{1,18}$/)
        .optional(),
    }),
  )
  .min(1)
  .max(100)

const createContractInput = z.strictObject({
  customerId: z.uuid(),
  lines: contractLines,
  recurrence: z.enum(RECURRENCES),
  startsOn: day,
  endsOn: day.optional(),
  billingDay: z.number().int().min(1).max(28),
  autoRenew: z.boolean().optional(),
  paymentTermDays: z.array(z.number().int().min(0).max(365)).min(1).max(12).optional(),
  sellerId: z.uuid().optional(),
  notes: z.string().max(500).optional(),
})

const amendInput = z.strictObject({
  effectiveFrom: day,
  lines: contractLines,
  recurrence: z.enum(RECURRENCES),
  reason: z.string().trim().min(10).max(500),
})

const renewInput = z.strictObject({
  readjustmentBasisPoints: z.number().int().min(-10_000).max(100_000).optional(),
  reason: z.string().trim().min(10).max(500),
})

const suspendInput = z.strictObject({ from: day, until: day.optional(), reason })
const resumeInput = z.strictObject({ at: day })
const cancelInput = z.strictObject({ from: day.optional(), reason })
const scheduleQuery = z.strictObject({ from: day.optional(), to: day.optional() })
const creditInput = z.strictObject({ reasonCode: z.enum(CREDIT_REASONS), reason })
const competence = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

function competenceOf(value: string): string {
  const parsed = competence.safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid competence month')
  return parsed.data
}

function contractId(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid contract id')
  return parsed.data
}

function parsed<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body ?? {})
  if (!result.success) throw new BadRequestException(`Invalid ${what}`)
  return result.data
}

/** Recurring service contracts (Phase 51, ADR 0056). */
@Controller('contracts')
export class ContractsController {
  constructor(@Inject(SalesRuntime) private readonly runtime: SalesRuntime) {}

  @Get()
  @RequireSalesAction('read')
  async list(@Req() request: SalesRequest) {
    const today = BusinessDate.of(new Date())
    const contracts = await this.runtime.database.listContracts(tenantOf(request))
    return contracts.map((contract) => view(contract, today))
  }

  @Get(':id')
  @RequireSalesAction('read')
  async read(@Param('id') id: string, @Req() request: SalesRequest) {
    const contract = await this.runtime.database.findContract(tenantOf(request), contractId(id))
    if (!contract) throw new NotFoundException('Contract was not found')
    return view(contract, BusinessDate.of(new Date()))
  }

  /** Which periods the contract has in a range, whether each bills, and with what. */
  @Get(':id/schedule')
  @RequireSalesAction('read')
  async schedule(@Param('id') id: string, @Query() query: unknown, @Req() request: SalesRequest) {
    const range = parsed(scheduleQuery, query, 'schedule range')
    const contract = await this.runtime.database.findContract(tenantOf(request), contractId(id))
    if (!contract) throw new NotFoundException('Contract was not found')
    const snapshot = contract.toSnapshot()
    const from = BusinessDate.create(range.from ?? snapshot.startsOn)
    const to = BusinessDate.create(range.to ?? BusinessDate.of(new Date()).plusDays(366).value)
    if (from.isLeft() || to.isLeft() || to.value.isBefore(from.value))
      throw new BadRequestException('Invalid schedule range')
    const billed = new Map(contract.billedPeriods().map((period) => [period.competence, period]))
    return {
      contractId: snapshot.id,
      currency: snapshot.currency,
      periods: contract.schedule({ from: from.value, to: to.value }).map((period) => ({
        index: period.index,
        startsOn: period.startsOn.value,
        endsOn: period.endsOn.value,
        competence: period.competence,
        billingOn: period.billingOn.value,
        revision: period.revision,
        amount: period.amount.amount.toString(),
        billable: period.billable,
        excluded: period.excluded,
        billedPeriodId: billed.get(period.competence)?.id ?? null,
        credited: Boolean(billed.get(period.competence)?.credit),
      })),
    }
  }

  /** The periods billed so far, frozen, with what their receivable and NFS-e became. */
  @Get(':id/billed-periods')
  @RequireSalesAction('read')
  async billedPeriods(@Param('id') id: string, @Req() request: SalesRequest) {
    const found = await this.runtime.database.findContractWithEffects(
      tenantOf(request),
      contractId(id),
    )
    if (!found) throw new NotFoundException('Contract was not found')
    const { contract, effects } = found
    return {
      contractId: contract.id.toString(),
      currency: contract.toSnapshot().currency,
      periods: contract.billedPeriods().map((period) => {
        const snapshot = billedSnapshot(period)
        const effect = effects.periods.get(period.id)
        return {
          ...snapshot,
          receivable: {
            titleId: effect?.receivableTitleId ?? null,
            postedAt: effect?.receivablePostedAt ?? null,
            reversedAt: effect?.receivableReversedAt ?? null,
          },
          lines: snapshot.lines.map((line) => {
            const nfse = effects.lines.get(line.entryId)
            return {
              ...line,
              nfse: { documentId: nfse?.nfseDocumentId ?? null, status: nfse?.nfseStatus ?? null },
            }
          }),
        }
      }),
    }
  }

  /** Bill one period now, outside any run; refused with the reason it cannot be billed. */
  @Post(':id/periods/:competence/bill')
  @RequireSalesAction('manage')
  async bill(
    @Param('id') id: string,
    @Param('competence') month: string,
    @Req() request: SalesRequest,
  ) {
    return this.unwrap(
      await this.runtime.billPeriod.execute({
        context: idempotent(request),
        contractId: contractId(id),
        competence: competenceOf(month),
      }),
    )
  }

  /** Credit a billed period in full; the period stays, marked credited. */
  @Post(':id/periods/:competence/credit')
  @RequireSalesAction('manage')
  async credit(
    @Param('id') id: string,
    @Param('competence') month: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const input = parsed(creditInput, body, 'credit')
    return this.unwrap(
      await this.runtime.creditPeriod.execute({
        ...input,
        context: idempotent(request),
        contractId: contractId(id),
        competence: competenceOf(month),
      }),
    )
  }

  @Post()
  @RequireSalesAction('manage')
  async create(@Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(createContractInput, body, 'contract')
    return this.unwrap(
      await this.runtime.createContract.execute({ ...input, context: idempotent(request) }),
    )
  }

  /** Renew every self-renewing contract whose last period has begun; safe to repeat. */
  @Post('renewals')
  @RequireSalesAction('manage')
  renewDue(@Req() request: SalesRequest) {
    return this.runtime.renewDueContracts.execute(context(request))
  }

  @Post(':id/activate')
  @RequireSalesAction('manage')
  async activate(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(await this.runtime.decideContract.activate(context(request), contractId(id)))
  }

  @Post(':id/amendments')
  @RequireSalesAction('manage')
  async amend(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(amendInput, body, 'amendment')
    return this.unwrap(
      await this.runtime.amendContract.execute({
        ...input,
        context: idempotent(request),
        contractId: contractId(id),
      }),
    )
  }

  @Post(':id/renewals')
  @RequireSalesAction('manage')
  async renew(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(renewInput, body, 'renewal')
    return this.unwrap(
      await this.runtime.renewContract.execute({
        ...input,
        context: idempotent(request),
        contractId: contractId(id),
      }),
    )
  }

  @Post(':id/suspensions')
  @RequireSalesAction('manage')
  async suspend(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(suspendInput, body, 'suspension')
    return this.unwrap(
      await this.runtime.decideContract.suspend(context(request), contractId(id), input),
    )
  }

  @Post(':id/resume')
  @RequireSalesAction('manage')
  async resume(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(resumeInput, body, 'resumption')
    return this.unwrap(
      await this.runtime.decideContract.resume(context(request), contractId(id), input.at),
    )
  }

  @Post(':id/cancel')
  @RequireSalesAction('manage')
  async cancel(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const input = parsed(cancelInput, body, 'cancellation')
    return this.unwrap(
      await this.runtime.decideContract.cancel(context(request), contractId(id), input),
    )
  }

  private unwrap<T>(result: { isRight(): boolean; value: unknown }): T {
    if (result.isRight()) return result.value as T
    const failure = result.value as { title: string; message: string }
    if (failure.title === 'Conflict') throw new ConflictException(failure.message)
    if (failure.title === 'Resource not found') throw new NotFoundException(failure.message)
    throw new BadRequestException(failure.message)
  }
}

function view(contract: ServiceContract, today: BusinessDate) {
  return { ...contract.toSnapshot(), status: contract.statusOn(today) }
}
