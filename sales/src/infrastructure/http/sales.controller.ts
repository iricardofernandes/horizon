import { fiscalTaxEstimateReferenceSchema } from '@horizon/contracts'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { z } from 'zod'
import { SalesRuntime } from '@/main/sales-runtime'
import {
  actorOf,
  PublicRoute,
  RequireSalesAction,
  type SalesRequest,
  tenantOf,
} from './authorization'
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

// The opportunity is named, never described: its owner and source come from Sales's own
// projection, so a body carrying them is refused (Phase 58).
const createQuoteInput = z.strictObject({
  customerId: z.uuid(),
  opportunityId: z.uuid().optional(),
  lines: quoteLines,
  terms: quoteTerms.optional(),
})

const reviseQuoteInput = z.strictObject({ lines: quoteLines, terms: quoteTerms.optional() })

// The warehouse is for the goods; a proposal of services alone converts without one.
const convertQuoteInput = z.strictObject({ fulfillmentWarehouseId: z.uuid().optional() })

const openServiceOrderInput = z.strictObject({
  customerId: z.uuid(),
  lines: quoteLines,
  terms: quoteTerms.pick({ discount: true, paymentTermDays: true, notes: true }).optional(),
  scheduledFor: z.iso.date().optional(),
})

const deliverServiceInput = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        lineId: z.uuid(),
        quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  performedOn: z.iso.date().optional(),
})

function uuidOf(value: string, what: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new BadRequestException(`Invalid ${what} id`)
  return parsed.data
}

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
        opportunityId: parsed.data.opportunityId,
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
    const converted = this.unwrap<{ quoteId: string; orderId: string | null }>(
      await this.runtime.convertQuote.execute({
        context: idempotent(request),
        quoteId: quoteId(id),
        fulfillmentWarehouseId: parsed.data.fulfillmentWarehouseId,
      }),
    )
    // The order keeps the estimate its quote was given, and its digests (Phase 87).
    if (converted.orderId)
      await this.runtime.database.carryTaxEstimate(
        tenantOf(request),
        converted.quoteId,
        converted.orderId,
        actorOf(request),
      )
    return converted
  }

  /** Fiscal's estimate, as the web asked Fiscal for it; labeled an estimate (ADR 0073). */
  @Get('quotes/:id/tax-estimate')
  @RequireSalesAction('read')
  quoteTaxEstimate(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.taxEstimate('quotes', id, request)
  }

  @Get('orders/:id/tax-estimate')
  @RequireSalesAction('read')
  orderTaxEstimate(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.taxEstimate('orders', id, request)
  }

  @Put('quotes/:id/tax-estimate')
  @RequireSalesAction('manage')
  recordQuoteTaxEstimate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    return this.recordTaxEstimate('quotes', id, body, request)
  }

  @Put('orders/:id/tax-estimate')
  @RequireSalesAction('manage')
  recordOrderTaxEstimate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    return this.recordTaxEstimate('orders', id, body, request)
  }

  private async taxEstimate(kind: 'quotes' | 'orders', id: string, request: SalesRequest) {
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new BadRequestException('Invalid document id')
    const found = await this.runtime.database.findTaxEstimate(
      tenantOf(request),
      kind === 'quotes' ? 'quote' : 'order',
      parsed.data,
    )
    if (!found) throw new NotFoundException('No tax estimate was recorded')
    return found
  }

  private async recordTaxEstimate(
    kind: 'quotes' | 'orders',
    id: string,
    body: unknown,
    request: SalesRequest,
  ) {
    const parsedId = z.uuid().safeParse(id)
    const reference = fiscalTaxEstimateReferenceSchema.safeParse(body)
    if (!parsedId.success || !reference.success)
      throw new BadRequestException('The digest of an estimate Fiscal issued is required')
    // Only the digest comes from the caller: the estimate is read back from Fiscal, as the
    // caller, and kept only if Fiscal was asked about this very document (Phase 91).
    const authorization = request.headers.authorization
    const bearer = typeof authorization === 'string' ? authorization.slice('Bearer '.length) : ''
    const issued = await this.runtime.fiscalEstimates.find(reference.data.resultDigest, bearer)
    if (issued.status === 'not-issued')
      throw new BadRequestException('Fiscal issued no estimate under this digest')
    if (issued.status === 'forbidden')
      throw new ForbiddenException('Reading the estimate needs read access to Fiscal')
    if (issued.status === 'unavailable')
      throw new ServiceUnavailableException('Fiscal could not be asked for the estimate')
    const outcome = await this.runtime.database.recordTaxEstimate({
      tenantId: tenantOf(request),
      kind: kind === 'quotes' ? 'quote' : 'order',
      documentId: parsedId.data,
      estimate: issued.record.estimate,
      request: issued.record.request,
      recordedBy: actorOf(request),
    })
    if (outcome === 'not-found') throw new NotFoundException('The document was not found')
    if (outcome === 'frozen')
      throw new ConflictException('The document no longer takes a new estimate')
    if (outcome === 'mismatch')
      throw new ConflictException('The estimate is not of this document’s customer and lines')
    return { recorded: true }
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
  /** The warehouse's work, which is not one order's: everything on its way out. */
  @Get('shipments')
  @RequireSalesAction('read')
  shipments(@Req() request: SalesRequest) {
    return this.runtime.database.listShipmentSnapshots(tenantOf(request))
  }

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

  @Get('service-orders')
  @RequireSalesAction('read')
  serviceOrders(@Req() request: SalesRequest) {
    return this.runtime.database.listServiceOrderSnapshots(tenantOf(request))
  }

  @Get('service-orders/:id')
  @RequireSalesAction('read')
  async serviceOrder(@Param('id') id: string, @Req() request: SalesRequest) {
    const found = await this.runtime.database.findServiceOrderWithEffects(
      tenantOf(request),
      uuidOf(id, 'service order'),
    )
    if (!found) throw new NotFoundException('Service order was not found')
    const { order, effects } = found
    // What each delivery raised, as Financial and Fiscal reported it (Phase 53).
    return {
      ...order,
      deliveries: order.deliveries.map((delivery) => {
        const receivable = effects.receivables.get(delivery.id)
        return {
          ...delivery,
          receivable: {
            titleId: receivable?.receivableTitleId ?? null,
            postedAt: receivable?.receivablePostedAt ?? null,
            reversedAt: receivable?.receivableReversedAt ?? null,
          },
          entries: delivery.entries.map((entry) => {
            const nfse = effects.nfse.get(entry.entryId)
            return {
              ...entry,
              nfse: { documentId: nfse?.documentId ?? null, status: nfse?.status ?? null },
            }
          }),
        }
      }),
    }
  }

  /** Services sold directly, without a proposal (ADR 0056). */
  @Post('service-orders')
  @RequireSalesAction('manage')
  async openServiceOrder(@Body() body: unknown, @Req() request: SalesRequest) {
    const parsed = openServiceOrderInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid service order')
    return this.unwrap(
      await this.runtime.openServiceOrder.execute({ ...parsed.data, context: idempotent(request) }),
    )
  }

  @Post('service-orders/:id/start')
  @RequireSalesAction('manage')
  async startServiceOrder(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(
      await this.runtime.decideServiceOrder.start(context(request), uuidOf(id, 'service order')),
    )
  }

  /** Work delivered: it is billed now, once. Without lines, everything still owed. */
  @Post('service-orders/:id/deliveries')
  @RequireSalesAction('manage')
  async deliverService(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const parsed = deliverServiceInput.safeParse(body ?? {})
    if (!parsed.success) throw new BadRequestException('Invalid delivery')
    return this.unwrap(
      await this.runtime.deliverService.execute({
        context: idempotent(request),
        serviceOrderId: uuidOf(id, 'service order'),
        lines: parsed.data.lines,
        performedOn: parsed.data.performedOn,
      }),
    )
  }

  @Post('service-orders/:id/accept')
  @RequireSalesAction('manage')
  async acceptServiceOrder(@Param('id') id: string, @Req() request: SalesRequest) {
    return this.unwrap(
      await this.runtime.decideServiceOrder.accept(context(request), uuidOf(id, 'service order')),
    )
  }

  @Post('service-orders/:id/cancel')
  @RequireSalesAction('manage')
  async cancelServiceOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const parsed = reasonInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid reason')
    return this.unwrap(
      await this.runtime.decideServiceOrder.cancel(
        context(request),
        uuidOf(id, 'service order'),
        parsed.data.reason,
      ),
    )
  }

  /** The work was not provided after all: its receivable and NFS-e are undone downstream. */
  @Post('service-orders/:id/deliveries/:deliveryId/cancel')
  @RequireSalesAction('manage')
  async cancelServiceDelivery(
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
    @Req() request: SalesRequest,
  ) {
    const parsed = reasonInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid reason')
    return this.unwrap(
      await this.runtime.decideServiceOrder.cancelDelivery(
        context(request),
        uuidOf(id, 'service order'),
        uuidOf(deliveryId, 'delivery'),
        parsed.data.reason,
      ),
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

  /** Orders by status and currency, which reporting reconciles against (Phase 62). */
  @Get('orders/summary')
  @RequireSalesAction('read')
  ordersSummary(@Req() request: SalesRequest) {
    return this.runtime.database.ordersSummary(tenantOf(request))
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
