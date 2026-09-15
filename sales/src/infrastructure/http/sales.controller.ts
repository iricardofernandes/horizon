import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { SalesRuntime } from '@/main/sales-runtime'
import { PublicRoute, RequireSalesAction, type SalesRequest, tenantOf } from './authorization'

const placeOrderInput = z.strictObject({
  customerId: z.uuid(),
  fulfillmentWarehouseId: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        itemId: z.uuid(),
        quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
      }),
    )
    .min(1)
    .max(100),
})

const createCustomerInput = z.strictObject({
  name: z.string().min(2).max(160),
  taxId: z.string().min(11).max(18),
  email: z.email().max(254),
  phone: z.string().min(8).max(24),
  address: z.string().min(5).max(500),
})

const createQuoteInput = z.strictObject({
  customerId: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        itemId: z.uuid(),
        quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
      }),
    )
    .min(1)
    .max(100),
})

@Controller()
export class SalesController {
  constructor(@Inject(SalesRuntime) private readonly runtime: SalesRuntime) {}

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

  @Get('customers')
  @RequireSalesAction('read')
  customers(@Req() request: SalesRequest) {
    return this.runtime.database.listCustomerSnapshots(tenantOf(request))
  }

  @Post('customers')
  @RequireSalesAction('manage')
  async createCustomer(@Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = createCustomerInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid customer')
    const result = await this.runtime.createCustomer.execute({
      ...parsed.data,
      tenantId: tenantOf(request),
    })
    if (result.isRight()) return result.value
    if (result.value.title === 'Conflict') throw new ConflictException(result.value.message)
    throw new BadRequestException(result.value.message)
  }

  /** Customer deletion is crypto-shredding: the row remains for document integrity while
   * its personally identifiable information becomes irrecoverable (ADR 0026). */
  @Delete('customers/:id')
  @RequireSalesAction('manage')
  @HttpCode(204)
  async eraseCustomer(@Param('id') id: string, @Req() request: SalesRequest) {
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new BadRequestException('Invalid customer id')
    const result = await this.runtime.eraseCustomer.execute({
      tenantId: tenantOf(request),
      customerId: parsed.data,
    })
    if (result.isLeft()) throw new NotFoundException(result.value.message)
  }

  @Get('quotes')
  @RequireSalesAction('read')
  quotes(@Req() request: SalesRequest) {
    return this.runtime.database.listQuoteSnapshots(tenantOf(request))
  }

  @Get('quotes/:id')
  @RequireSalesAction('read')
  async quote(@Param('id') id: string, @Req() request: SalesRequest) {
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new BadRequestException('Invalid quote id')
    const quote = await this.runtime.database.findQuoteSnapshot(tenantOf(request), parsed.data)
    if (!quote) throw new NotFoundException('Quote was not found')
    return quote
  }

  @Post('quotes')
  @RequireSalesAction('manage')
  async createQuote(@Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = createQuoteInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid quote')
    const result = await this.runtime.createQuote.execute({
      ...parsed.data,
      tenantId: tenantOf(request),
    })
    if (result.isRight()) return result.value
    if (result.value.title === 'Conflict') throw new ConflictException(result.value.message)
    if (result.value.title === 'Resource not found')
      throw new NotFoundException(result.value.message)
    throw new BadRequestException(result.value.message)
  }

  @Post('quotes/:id/accept')
  @RequireSalesAction('manage')
  @HttpCode(204)
  async acceptQuote(@Param('id') id: string, @Req() request: SalesRequest) {
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new BadRequestException('Invalid quote id')
    const result = await this.runtime.acceptQuote.execute({
      tenantId: tenantOf(request),
      quoteId: parsed.data,
    })
    if (result.isRight()) return
    if (result.value.title === 'Resource not found')
      throw new NotFoundException(result.value.message)
    throw new ConflictException(result.value.message)
  }

  @Get('orders')
  @RequireSalesAction('read')
  orders(@Req() request: SalesRequest) {
    return this.runtime.database.listOrderSnapshots(tenantOf(request))
  }

  @Get('orders/:id')
  @RequireSalesAction('read')
  async order(@Param('id') id: string, @Req() request: SalesRequest) {
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new BadRequestException('Invalid order id')
    const order = await this.runtime.database.findOrderSnapshot(tenantOf(request), parsed.data)
    if (!order) throw new NotFoundException('Sales order was not found')
    return order
  }

  @Post('orders')
  @RequireSalesAction('manage')
  async placeOrder(@Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = placeOrderInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid sales order')
    const result = await this.runtime.placeOrder.execute({
      ...parsed.data,
      tenantId: tenantOf(request),
    })
    if (result.isLeft()) throw new BadRequestException(result.value.message)
    return result.value
  }
}
