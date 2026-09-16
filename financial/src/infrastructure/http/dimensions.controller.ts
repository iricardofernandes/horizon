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
  Query,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import type { DimensionRegistry } from '@/application/use-cases/manage-dimensions'
import { DIMENSION_KINDS } from '@/domain/entities/analytic-dimension'
import { CATEGORY_NATURES } from '@/domain/entities/financial-category'
import { PAYMENT_METHOD_KINDS } from '@/domain/entities/payment-method'
import { MAX_INSTALLMENTS } from '@/domain/entities/payment-term'
import { FinancialRuntime } from '@/main/financial-runtime'
import {
  type FinancialRequest,
  PublicRoute,
  RequireFinancialAction,
  tenantOf,
} from './authorization'
import { id, parse, unwrap } from './request-parsing'

const code = z.string().trim().min(1).max(20)
const name = z.string().trim().min(2).max(120)
const percentage = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/)
const money = z.strictObject({
  amount: z.string().regex(/^\d{1,18}$/),
  currency: z.string().length(3),
})

const categoryInput = z.strictObject({
  code,
  name,
  nature: z.enum(CATEGORY_NATURES),
  parentId: z.uuid().optional(),
})
const dimensionInput = z.strictObject({ kind: z.enum(DIMENSION_KINDS), code, name })
const paymentMethodInput = z.strictObject({ kind: z.enum(PAYMENT_METHOD_KINDS), code, name })
const paymentTermInput = z.strictObject({
  name,
  installments: z
    .array(z.strictObject({ dueInDays: z.number().int(), percentage }))
    .min(1)
    .max(MAX_INSTALLMENTS),
})
const statusInput = z.strictObject({ active: z.boolean() })
const scheduleInput = z.strictObject({ total: money, issuedOn: z.iso.date() })
const allocationInput = z.strictObject({
  total: money,
  entries: z
    .array(z.strictObject({ dimensionId: z.uuid(), percentage }))
    .min(1)
    .max(50),
})

@Controller()
export class DimensionsController {
  constructor(@Inject(FinancialRuntime) private readonly runtime: FinancialRuntime) {}

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

  @Get('categories')
  @RequireFinancialAction('read')
  async categories(@Req() request: FinancialRequest) {
    return { data: await this.runtime.database.listCategories(tenantOf(request)) }
  }

  @Post('categories')
  @RequireFinancialAction('configure')
  async defineCategory(@Body() body: unknown, @Req() request: FinancialRequest) {
    return unwrap(
      await this.runtime.defineCategory.execute({
        ...parse(categoryInput, body),
        tenantId: tenantOf(request),
      }),
    )
  }

  @Get('dimensions')
  @RequireFinancialAction('read')
  async dimensions(@Query('kind') kind: string | undefined, @Req() request: FinancialRequest) {
    const filter = kind === undefined ? undefined : parse(z.enum(DIMENSION_KINDS), kind)
    return { data: await this.runtime.database.listDimensions(tenantOf(request), filter) }
  }

  @Post('dimensions')
  @RequireFinancialAction('configure')
  async defineDimension(@Body() body: unknown, @Req() request: FinancialRequest) {
    return unwrap(
      await this.runtime.defineDimension.execute({
        ...parse(dimensionInput, body),
        tenantId: tenantOf(request),
      }),
    )
  }

  @Get('payment-methods')
  @RequireFinancialAction('read')
  async paymentMethods(@Req() request: FinancialRequest) {
    return { data: await this.runtime.database.listPaymentMethods(tenantOf(request)) }
  }

  @Post('payment-methods')
  @RequireFinancialAction('configure')
  async definePaymentMethod(@Body() body: unknown, @Req() request: FinancialRequest) {
    return unwrap(
      await this.runtime.definePaymentMethod.execute({
        ...parse(paymentMethodInput, body),
        tenantId: tenantOf(request),
      }),
    )
  }

  @Get('payment-terms')
  @RequireFinancialAction('read')
  async paymentTerms(@Req() request: FinancialRequest) {
    return { data: await this.runtime.database.listPaymentTerms(tenantOf(request)) }
  }

  @Post('payment-terms')
  @RequireFinancialAction('configure')
  async definePaymentTerm(@Body() body: unknown, @Req() request: FinancialRequest) {
    return unwrap(
      await this.runtime.definePaymentTerm.execute({
        ...parse(paymentTermInput, body),
        tenantId: tenantOf(request),
      }),
    )
  }

  /** The installments an amount would produce, due dates included. Nothing is stored. */
  @Post('payment-terms/:id/schedule')
  @RequireFinancialAction('read')
  @HttpCode(200)
  async schedule(
    @Param('id') termId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    const input = parse(scheduleInput, body)
    return {
      installments: unwrap(
        await this.runtime.previewSchedule.execute({
          tenantId: tenantOf(request),
          paymentTermId: id(termId),
          ...input,
        }),
      ),
    }
  }

  /** How an amount divides across departments or projects. Shares must total exactly 100%. */
  @Post('allocations/preview')
  @RequireFinancialAction('read')
  @HttpCode(200)
  async allocation(@Body() body: unknown, @Req() request: FinancialRequest) {
    return {
      parts: unwrap(
        await this.runtime.previewAllocation.execute({
          ...parse(allocationInput, body),
          tenantId: tenantOf(request),
        }),
      ),
    }
  }

  @Patch(':registry/:id/status')
  @RequireFinancialAction('configure')
  @HttpCode(204)
  async changeStatus(
    @Param('registry') registry: string,
    @Param('id') entryId: string,
    @Body() body: unknown,
    @Req() request: FinancialRequest,
  ) {
    const registries: Record<string, DimensionRegistry> = {
      categories: 'categories',
      dimensions: 'dimensions',
      'payment-methods': 'paymentMethods',
      'payment-terms': 'paymentTerms',
    }
    const target = registries[registry]
    if (!target) throw new NotFoundException('Unknown registry')
    unwrap(
      await this.runtime.changeStatus.execute({
        tenantId: tenantOf(request),
        registry: target,
        id: id(entryId),
        active: parse(statusInput, body).active,
      }),
    )
  }
}
