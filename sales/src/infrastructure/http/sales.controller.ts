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
  Req,
} from '@nestjs/common'
import { z } from 'zod'
import { SalesRuntime } from '@/main/sales-runtime'
import { PublicRoute, RequireSalesAction, type SalesRequest, tenantOf } from './authorization'
import { context, idempotent } from './command-context'

const placeOrderInput = z.strictObject({
  customerId: z.uuid(),
  fulfillmentWarehouseId: z.uuid(),
  currency: z.string().length(3).optional(),
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

const quoteLines = z
  .array(
    z.strictObject({
      lineId: z.uuid(),
      itemId: z.uuid(),
      quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
    }),
  )
  .min(1)
  .max(100)

const quoteTerms = z.strictObject({
  sellerId: z.uuid().optional(),
  discount: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  freight: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  carrier: z.string().trim().min(2).max(120).optional(),
  paymentTermDays: z.array(z.number().int().min(0).max(365)).min(1).max(12).optional(),
  notes: z.string().max(500).optional(),
})

const createQuoteInput = z.strictObject({
  customerId: z.uuid(),
  lines: quoteLines,
  terms: quoteTerms.optional(),
})

const reviseQuoteInput = z.strictObject({ lines: quoteLines, terms: quoteTerms.optional() })

const convertQuoteInput = z.strictObject({ fulfillmentWarehouseId: z.uuid() })

const consignment = z.strictObject({
  carrier: z.string().trim().min(2).max(120).optional(),
  trackingCode: z.string().trim().min(1).max(120).optional(),
})

const pickShipmentInput = z.strictObject({
  orderId: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
      }),
    )
    .min(1)
    .max(100),
})

const packShipmentInput = z.strictObject({ consignment: consignment.optional() })

const dispatchShipmentInput = z.strictObject({
  dispatchedOn: z.iso.date().optional(),
  consignment: consignment.optional(),
})

const returnShipmentInput = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  returnedOn: z.iso.date().optional(),
})

function shipmentId(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid shipment id')
  return parsed.data
}

const reasonInput = z.strictObject({ reason: z.string().trim().min(1).max(500) })

function quoteId(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new BadRequestException('Invalid quote id')
  return parsed.data
}

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

  /** Read-only: customers are registered in `parties/` and projected here (ADR 0040). */
  @Get('customers')
  @RequireSalesAction('read')
  customers(@Req() request: SalesRequest) {
    return this.runtime.database.listCustomerSnapshots(tenantOf(request))
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
    return this.unwrap(
      await this.runtime.writeQuote.execute({
        context: idempotent(request),
        customerId: parsed.data.customerId,
        quote: { lines: parsed.data.lines, terms: parsed.data.terms },
      }),
    )
  }

  /** A draft changes in place; a sent offer is answered with a new version of itself. */
  @Post('quotes/:id/revise')
  @RequireSalesAction('manage')
  async reviseQuote(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = reviseQuoteInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid quote')
    return this.unwrap(
      await this.runtime.reviseQuote.execute({
        context: idempotent(request),
        quoteId: quoteId(id),
        quote: parsed.data,
      }),
    )
  }

  @Post('quotes/:id/send')
  @RequireSalesAction('manage')
  async sendQuote(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(await this.runtime.decideQuote.send(context(request), quoteId(id)))
  }

  @Post('quotes/:id/approve')
  @RequireSalesAction('manage')
  async approveQuote(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(await this.runtime.decideQuote.approve(context(request), quoteId(id)))
  }

  @Post('quotes/:id/refuse')
  @RequireSalesAction('manage')
  async refuseQuote(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = reasonInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid reason')
    return this.unwrap(
      await this.runtime.decideQuote.refuse(context(request), quoteId(id), parsed.data.reason),
    )
  }

  @Post('quotes/:id/accept')
  @RequireSalesAction('manage')
  async acceptQuote(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(await this.runtime.decideQuote.accept(context(request), quoteId(id)))
  }

  /** The offer the customer agreed to, made binding as the order that delivers it. */
  @Post('quotes/:id/order')
  @RequireSalesAction('manage')
  async convertQuote(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = convertQuoteInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid conversion')
    return this.unwrap(
      await this.runtime.convertQuote.execute({
        context: idempotent(request),
        quoteId: quoteId(id),
        fulfillmentWarehouseId: parsed.data.fulfillmentWarehouseId,
      }),
    )
  }

  @Post('quotes/:id/decline')
  @RequireSalesAction('manage')
  async declineQuote(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = reasonInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid reason')
    return this.unwrap(
      await this.runtime.decideQuote.decline(context(request), quoteId(id), parsed.data.reason),
    )
  }

  @Post('quotes/:id/expire')
  @RequireSalesAction('manage')
  async expireQuote(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(await this.runtime.decideQuote.expire(context(request), quoteId(id)))
  }

  /** Everything being picked, packed or gone for one order. */
  @Get('orders/:id/shipments')
  @RequireSalesAction('read')
  async shipmentsOfOrder(@Param('id') id: string, @Req() request: SalesRequest) {
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new BadRequestException('Invalid order id')
    return this.runtime.database.listShipmentSnapshots(tenantOf(request), parsed.data)
  }

  @Get('shipments/:id')
  @RequireSalesAction('read')
  async shipment(@Param('id') id: string, @Req() request: SalesRequest) {
    const shipment = await this.runtime.database.findShipmentSnapshot(
      tenantOf(request),
      shipmentId(id),
    )
    if (!shipment) throw new NotFoundException('Shipment was not found')
    return shipment
  }

  /** Take goods off the shelf for a customer; the quantities are held against the order. */
  @Post('shipments')
  @RequireSalesAction('manage')
  async pickShipment(@Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = pickShipmentInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid shipment')
    return this.unwrap(
      await this.runtime.pickShipment.execute({
        context: idempotent(request),
        orderId: parsed.data.orderId,
        lines: parsed.data.lines,
      }),
    )
  }

  @Post('shipments/:id/pack')
  @RequireSalesAction('manage')
  async packShipment(@Param('id') id: string, @Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = packShipmentInput.safeParse(body ?? {})
    if (!parsed.success) throw new BadRequestException('Invalid consignment')
    return this.unwrap(
      await this.runtime.packShipment.execute({
        context: context(request),
        shipmentId: shipmentId(id),
        consignment: parsed.data.consignment,
      }),
    )
  }

  /** The goods leave: stock moves, the customer owes this delivery's share of the order. */
  @Post('shipments/:id/dispatch')
  @RequireSalesAction('manage')
  async dispatchShipment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const parsed = dispatchShipmentInput.safeParse(body ?? {})
    if (!parsed.success) throw new BadRequestException('Invalid dispatch')
    return this.unwrap(
      await this.runtime.dispatchShipment.execute({
        context: idempotent(request),
        shipmentId: shipmentId(id),
        dispatchedOn: parsed.data.dispatchedOn,
        consignment: parsed.data.consignment,
      }),
    )
  }

  @Post('shipments/:id/return')
  @RequireSalesAction('manage')
  async returnShipment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const parsed = returnShipmentInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid return')
    return this.unwrap(
      await this.runtime.returnShipment.execute({
        context: idempotent(request),
        shipmentId: shipmentId(id),
        reason: parsed.data.reason,
        returnedOn: parsed.data.returnedOn,
      }),
    )
  }

  @Post('shipments/:id/abandon')
  @RequireSalesAction('manage')
  async abandonShipment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const parsed = reasonInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid reason')
    return this.unwrap(
      await this.runtime.abandonShipment.execute({
        context: context(request),
        shipmentId: shipmentId(id),
        reason: parsed.data.reason,
      }),
    )
  }

  private unwrap<T>(result: { isRight(): boolean; value: unknown }): T {
    if (result.isRight()) return result.value as T
    const failure = result.value as { title: string; message: string }
    if (failure.title === 'Conflict') throw new ConflictException(failure.message)
    if (failure.title === 'Resource not found') throw new NotFoundException(failure.message)
    throw new BadRequestException(failure.message)
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
    return this.unwrap(
      await this.runtime.placeOrder.execute({
        ...parsed.data,
        context: idempotent(request),
      }),
    )
  }
}
