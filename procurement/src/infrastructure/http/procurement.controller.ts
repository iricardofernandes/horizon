import {
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
import { ORDER_STATUSES } from '@/domain/entities/purchase-order'
import { REQUISITION_STATUSES } from '@/domain/entities/purchase-requisition'
import { ProcurementRuntime } from '@/main/procurement-runtime'
import {
  type ProcurementRequest,
  PublicRoute,
  RequireProcurementAction,
  tenantOf,
} from './authorization'
import { context, idempotent, pageOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const minorUnits = z.string().regex(/^\d{1,18}$/)
const quantity = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/)
const businessDate = z.iso.date()
const currency = z.string().length(3)
const description = z.string().trim().min(1).max(160)
const reasonInput = z.strictObject({ reason: z.string().trim().min(3).max(300) })
const paymentTermDays = z.array(z.number().int().min(0).max(365)).min(1).max(12)

const requestedLine = z.strictObject({
  lineId: z.uuid(),
  itemId: z.uuid(),
  description: description.optional(),
  quantity,
})

const pricedLine = requestedLine.extend({ unitPrice: minorUnits })

const charges = z.strictObject({
  tax: minorUnits.optional(),
  freight: minorUnits.optional(),
  otherCharges: minorUnits.optional(),
  discount: minorUnits.optional(),
})

const requisitionInput = z.strictObject({
  warehouseId: z.uuid(),
  neededBy: businessDate,
  justification: z.string().max(500).optional(),
  lines: z.array(requestedLine).min(1).max(200),
})

const quotationInput = z.strictObject({
  requisitionId: z.uuid(),
  supplierId: z.uuid(),
  reference: z.string().trim().min(1).max(40),
  quotedOn: businessDate,
  validUntil: businessDate.optional(),
  currency,
  lines: z.array(pricedLine).min(1).max(200),
  charges: charges.optional(),
  paymentTermDays: paymentTermDays.optional(),
  leadTimeDays: z.number().int().min(0).max(365),
  notes: z.string().max(500).optional(),
})

const orderInput = z.strictObject({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  requisitionId: z.uuid().optional(),
  currency,
  lines: z.array(pricedLine).min(1).max(200),
  charges: charges.optional(),
  paymentTermDays: paymentTermDays.optional(),
  issuedOn: businessDate,
  expectedOn: businessDate,
  notes: z.string().max(500).optional(),
})

const orderRevision = orderInput.omit({
  supplierId: true,
  warehouseId: true,
  requisitionId: true,
  issuedOn: true,
})

const fromQuotationInput = z.strictObject({
  quotationId: z.uuid(),
  issuedOn: businessDate,
  expectedOn: businessDate.optional(),
  notes: z.string().max(500).optional(),
})

const deliveryInput = z.strictObject({
  orderId: z.uuid(),
  receivedOn: businessDate,
  lines: z
    .array(z.strictObject({ lineId: z.uuid(), quantity }))
    .min(1)
    .max(200),
  notes: z.string().max(500).optional(),
  overrideReason: z.string().trim().min(3).max(300).optional(),
})

const policyInput = z.strictObject({ currency, threshold: minorUnits })

@Controller()
export class ProcurementController {
  constructor(@Inject(ProcurementRuntime) private readonly runtime: ProcurementRuntime) {}

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

  @Get('requisitions')
  @RequireProcurementAction('read')
  requisitions(@Query() query: unknown, @Req() request: ProcurementRequest) {
    const status = parse(
      z.enum(REQUISITION_STATUSES).optional(),
      (query as Record<string, unknown>)?.status,
    )
    return this.runtime.database.listRequisitions(tenantOf(request), {
      status: status ?? null,
      ...pageOf(query),
    })
  }

  @Get('requisitions/:id')
  @RequireProcurementAction('read')
  async requisition(@Param('id') requisitionId: string, @Req() request: ProcurementRequest) {
    const detail = await this.runtime.database.requisitionDetail(
      tenantOf(request),
      id(requisitionId),
    )
    if (!detail) throw new NotFoundException('requisition was not found')
    return detail
  }

  @Post('requisitions')
  @RequireProcurementAction('write')
  async openRequisition(@Body() body: unknown, @Req() request: ProcurementRequest) {
    return unwrap(
      await this.runtime.openRequisition.execute({
        context: idempotent(request),
        requisition: parse(requisitionInput, body),
      }),
    )
  }

  @Put('requisitions/:id')
  @RequireProcurementAction('write')
  @HttpCode(204)
  async reviseRequisition(
    @Param('id') requisitionId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    unwrap(
      await this.runtime.reviseRequisition.execute({
        context: context(request),
        requisitionId: id(requisitionId),
        requisition: parse(requisitionInput.omit({ warehouseId: true }), body),
      }),
    )
  }

  @Post('requisitions/:id/submit')
  @RequireProcurementAction('write')
  async submitRequisition(@Param('id') requisitionId: string, @Req() request: ProcurementRequest) {
    return unwrap(await this.runtime.decideRequisition.submit(context(request), id(requisitionId)))
  }

  @Post('requisitions/:id/approve')
  @RequireProcurementAction('decide')
  async approveRequisition(@Param('id') requisitionId: string, @Req() request: ProcurementRequest) {
    return unwrap(await this.runtime.decideRequisition.approve(context(request), id(requisitionId)))
  }

  @Post('requisitions/:id/reject')
  @RequireProcurementAction('decide')
  async rejectRequisition(
    @Param('id') requisitionId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    const { reason } = parse(reasonInput, body)
    return unwrap(
      await this.runtime.decideRequisition.reject(context(request), id(requisitionId), reason),
    )
  }

  @Post('requisitions/:id/cancel')
  @RequireProcurementAction('write')
  async cancelRequisition(
    @Param('id') requisitionId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    const { reason } = parse(reasonInput, body)
    return unwrap(
      await this.runtime.decideRequisition.cancel(context(request), id(requisitionId), reason),
    )
  }

  @Get('requisitions/:id/quotations')
  @RequireProcurementAction('read')
  quotations(@Param('id') requisitionId: string, @Req() request: ProcurementRequest) {
    return this.runtime.database.listQuotations(tenantOf(request), id(requisitionId))
  }

  /** Every offer against every line, with the cheapest unit price per line marked. */
  @Get('requisitions/:id/comparison')
  @RequireProcurementAction('read')
  comparison(@Param('id') requisitionId: string, @Req() request: ProcurementRequest) {
    return this.runtime.database.quotationComparison(tenantOf(request), id(requisitionId))
  }

  @Post('quotations')
  @RequireProcurementAction('write')
  async recordQuotation(@Body() body: unknown, @Req() request: ProcurementRequest) {
    return unwrap(
      await this.runtime.recordQuotation.execute({
        context: idempotent(request),
        quotation: parse(quotationInput, body),
      }),
    )
  }

  @Post('quotations/:id/select')
  @RequireProcurementAction('commit')
  async selectQuotation(@Param('id') quotationId: string, @Req() request: ProcurementRequest) {
    return unwrap(
      await this.runtime.selectQuotation.execute({
        context: context(request),
        quotationId: id(quotationId),
      }),
    )
  }

  @Post('quotations/:id/decline')
  @RequireProcurementAction('commit')
  @HttpCode(204)
  async declineQuotation(@Param('id') quotationId: string, @Req() request: ProcurementRequest) {
    unwrap(
      await this.runtime.declineQuotation.execute({
        context: context(request),
        quotationId: id(quotationId),
      }),
    )
  }

  @Get('orders')
  @RequireProcurementAction('read')
  orders(@Query() query: unknown, @Req() request: ProcurementRequest) {
    const filters = query as Record<string, unknown>
    return this.runtime.database.listOrders(tenantOf(request), {
      status: parse(z.enum(ORDER_STATUSES).optional(), filters?.status) ?? null,
      supplierId: parse(z.uuid().optional(), filters?.supplierId) ?? null,
      ...pageOf(query),
    })
  }

  @Get('orders/:id')
  @RequireProcurementAction('read')
  async order(@Param('id') orderId: string, @Req() request: ProcurementRequest) {
    const detail = await this.runtime.database.orderDetail(tenantOf(request), id(orderId))
    if (!detail) throw new NotFoundException('purchase order was not found')
    return detail
  }

  @Post('orders')
  @RequireProcurementAction('write')
  async draftOrder(@Body() body: unknown, @Req() request: ProcurementRequest) {
    return unwrap(
      await this.runtime.draftOrder.execute({
        context: idempotent(request),
        order: parse(orderInput, body),
      }),
    )
  }

  @Post('orders/from-quotation')
  @RequireProcurementAction('write')
  async draftOrderFromQuotation(@Body() body: unknown, @Req() request: ProcurementRequest) {
    return unwrap(
      await this.runtime.draftOrderFromQuotation.execute({
        context: idempotent(request),
        ...parse(fromQuotationInput, body),
      }),
    )
  }

  @Put('orders/:id')
  @RequireProcurementAction('write')
  async reviseOrder(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    return unwrap(
      await this.runtime.reviseOrder.execute({
        context: context(request),
        orderId: id(orderId),
        order: parse(orderRevision, body),
      }),
    )
  }

  @Post('orders/:id/place')
  @RequireProcurementAction('commit')
  async placeOrder(@Param('id') orderId: string, @Req() request: ProcurementRequest) {
    return unwrap(await this.runtime.decideOrder.place(context(request), id(orderId)))
  }

  @Post('orders/:id/approve')
  @RequireProcurementAction('decide')
  async approveOrder(@Param('id') orderId: string, @Req() request: ProcurementRequest) {
    return unwrap(await this.runtime.decideOrder.approve(context(request), id(orderId)))
  }

  @Post('orders/:id/reject')
  @RequireProcurementAction('decide')
  async rejectOrder(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    const { reason } = parse(reasonInput, body)
    return unwrap(await this.runtime.decideOrder.reject(context(request), id(orderId), reason))
  }

  @Post('orders/:id/cancel')
  @RequireProcurementAction('commit')
  async cancelOrder(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    const { reason } = parse(reasonInput, body)
    return unwrap(await this.runtime.decideOrder.cancel(context(request), id(orderId), reason))
  }

  @Post('orders/:id/close')
  @RequireProcurementAction('commit')
  async closeOrder(
    @Param('id') orderId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    const { reason } = parse(reasonInput, body)
    return unwrap(
      await this.runtime.closeOrder.execute({
        context: context(request),
        orderId: id(orderId),
        reason,
      }),
    )
  }

  @Get('orders/:id/receipts')
  @RequireProcurementAction('read')
  receipts(@Param('id') orderId: string, @Req() request: ProcurementRequest) {
    return this.runtime.database.listReceipts(tenantOf(request), id(orderId))
  }

  /** Conference: what arrived against the order, and what the order is still waiting for. */
  @Post('receipts')
  @RequireProcurementAction('write')
  async receiveGoods(@Body() body: unknown, @Req() request: ProcurementRequest) {
    return unwrap(
      await this.runtime.receiveGoods.execute({
        context: idempotent(request),
        delivery: parse(deliveryInput, body),
      }),
    )
  }

  @Post('receipts/:id/return')
  @RequireProcurementAction('write')
  @HttpCode(204)
  async returnGoods(
    @Param('id') receiptId: string,
    @Body() body: unknown,
    @Req() request: ProcurementRequest,
  ) {
    const { reason } = parse(reasonInput, body)
    unwrap(
      await this.runtime.returnGoods.execute({
        context: context(request),
        receiptId: id(receiptId),
        reason,
      }),
    )
  }

  @Get('suppliers')
  @RequireProcurementAction('read')
  suppliers(@Query('limit') limit: unknown, @Req() request: ProcurementRequest) {
    const parsed = parse(z.coerce.number().int().min(1).max(500).default(200), limit ?? undefined)
    return this.runtime.database.listSuppliers(tenantOf(request), parsed)
  }

  @Get('approval-policies')
  @RequireProcurementAction('read')
  policies(@Req() request: ProcurementRequest) {
    return this.runtime.database.listPolicies(tenantOf(request))
  }

  @Put('approval-policies')
  @RequireProcurementAction('configure')
  async definePolicy(@Body() body: unknown, @Req() request: ProcurementRequest) {
    const input = parse(policyInput, body)
    const policy = unwrap(
      await this.runtime.defineApprovalPolicy.execute({ context: context(request), ...input }),
    )
    return { currency: policy.currency, threshold: policy.threshold.toString() }
  }
}
