import {
  BadRequestException,
  Body,
  ConflictException,
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
import { InventoryRuntime } from '@/main/inventory-runtime'
import {
  type InventoryRequest,
  PublicRoute,
  RequireInventoryAction,
  tenantOf,
} from './authorization'
import { context, idempotent, pageOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const quantity = z.string().regex(/^\d+(?:\.\d{1,6})?$/)
const amount = z.string().regex(/^\d+$/).max(30)
const currency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
const note = z.string().min(1).max(500)

const createWarehouseInput = z.strictObject({ name: z.string().min(1).max(120) })

const receiveStockInput = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  quantity,
  unitCost: amount,
  currency,
})

const transferInput = z.strictObject({
  sourceWarehouseId: z.uuid(),
  destinationWarehouseId: z.uuid(),
  lines: z
    .array(z.strictObject({ itemId: z.uuid(), quantity }))
    .min(1)
    .max(200),
  note: note.nullish(),
})

const adjustmentInput = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  direction: z.enum(['in', 'out']),
  quantity,
  reason: z.enum(['breakage', 'loss', 'theft', 'expiry', 'found', 'correction']),
  note: note.nullish(),
  unitCost: z.strictObject({ amount, currency }).nullish(),
})

const countInput = z.strictObject({
  warehouseId: z.uuid(),
  itemIds: z.array(z.uuid()).max(2000).nullish(),
  note: note.nullish(),
})

const countFiguresInput = z.strictObject({
  counts: z
    .array(z.strictObject({ itemId: z.uuid(), counted: quantity }))
    .min(1)
    .max(2000),
})

const reasonInput = z.strictObject({ reason: note })
const policyInput = z.strictObject({ currency, threshold: amount })
const listFilter = z.object({
  status: z.string().max(20).nullish(),
  warehouseId: z.uuid().nullish(),
})

@Controller()
export class InventoryController {
  constructor(@Inject(InventoryRuntime) private readonly runtime: InventoryRuntime) {}

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

  @Get('warehouses')
  @RequireInventoryAction('read')
  warehouses(@Req() request: InventoryRequest) {
    return this.runtime.database.listWarehouseSnapshots(tenantOf(request))
  }

  @Post('warehouses')
  @RequireInventoryAction('manage')
  async createWarehouse(@Body() body: unknown, @Req() request: InventoryRequest) {
    const parsed = createWarehouseInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid warehouse')
    const result = await this.runtime.createWarehouse.execute({
      tenantId: tenantOf(request),
      ...parsed.data,
    })
    if (result.isRight()) return result.value
    if (result.value.title === 'Conflict') throw new ConflictException(result.value.message)
    throw new BadRequestException(result.value.message)
  }

  @Patch('warehouses/:id/deactivate')
  @RequireInventoryAction('manage')
  @HttpCode(204)
  async deactivateWarehouse(@Param('id') warehouseId: string, @Req() request: InventoryRequest) {
    const parsed = z.uuid().safeParse(warehouseId)
    if (!parsed.success) throw new BadRequestException('Invalid warehouse id')
    const result = await this.runtime.deactivateWarehouse.execute({
      tenantId: tenantOf(request),
      warehouseId: parsed.data,
    })
    if (result.isRight()) return
    if (result.value.title === 'Resource not found')
      throw new NotFoundException(result.value.message)
    throw new ConflictException(result.value.message)
  }

  @Post('stock-receipts')
  @RequireInventoryAction('manage')
  async receiveStock(@Body() body: unknown, @Req() request: InventoryRequest) {
    const parsed = receiveStockInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Invalid stock receipt')
    const result = await this.runtime.receiveStock.execute({
      tenantId: tenantOf(request),
      ...parsed.data,
    })
    if (result.isRight()) return result.value
    if (result.value.title === 'Resource not found')
      throw new NotFoundException(result.value.message)
    if (result.value.title === 'Conflict') throw new ConflictException(result.value.message)
    throw new BadRequestException(result.value.message)
  }

  // ---------------------------------------------------------------- transfers

  @Get('stock-transfers')
  @RequireInventoryAction('read')
  transfers(@Query() query: unknown, @Req() request: InventoryRequest) {
    return this.runtime.database.listTransfers(tenantOf(request), pageOf(query))
  }

  @Post('stock-transfers')
  @RequireInventoryAction('manage')
  async transfer(@Body() body: unknown, @Req() request: InventoryRequest) {
    return unwrap(
      await this.runtime.transferStock.execute({
        context: idempotent(request),
        ...parse(transferInput, body),
      }),
    )
  }

  // ---------------------------------------------------------------- adjustments

  @Get('stock-adjustments')
  @RequireInventoryAction('read')
  adjustments(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(listFilter, query)
    return this.runtime.database.listAdjustments(tenantOf(request), {
      status: filter.status ?? null,
      warehouseId: filter.warehouseId ?? null,
      ...pageOf(query),
    })
  }

  @Post('stock-adjustments')
  @RequireInventoryAction('manage')
  async adjust(@Body() body: unknown, @Req() request: InventoryRequest) {
    return unwrap(
      await this.runtime.adjustStock.execute({
        context: idempotent(request),
        ...parse(adjustmentInput, body),
      }),
    )
  }

  @Patch('stock-adjustments/:id/approve')
  @RequireInventoryAction('approve')
  async approveAdjustment(@Param('id') adjustmentId: string, @Req() request: InventoryRequest) {
    return unwrap(
      await this.runtime.decideAdjustment.execute({
        context: context(request),
        adjustmentId: id(adjustmentId),
        decision: { kind: 'approve' },
      }),
    )
  }

  @Patch('stock-adjustments/:id/reject')
  @RequireInventoryAction('approve')
  async rejectAdjustment(
    @Param('id') adjustmentId: string,
    @Body() body: unknown,
    @Req() request: InventoryRequest,
  ) {
    return unwrap(
      await this.runtime.decideAdjustment.execute({
        context: context(request),
        adjustmentId: id(adjustmentId),
        decision: { kind: 'reject', reason: parse(reasonInput, body).reason },
      }),
    )
  }

  // ---------------------------------------------------------------- counts

  @Get('stock-counts')
  @RequireInventoryAction('read')
  counts(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(listFilter, query)
    return this.runtime.database.listCounts(tenantOf(request), {
      status: filter.status ?? null,
      warehouseId: filter.warehouseId ?? null,
      ...pageOf(query),
    })
  }

  @Get('stock-counts/:id')
  @RequireInventoryAction('read')
  async count(@Param('id') countId: string, @Req() request: InventoryRequest) {
    const detail = await this.runtime.database.countDetail(tenantOf(request), id(countId))
    if (!detail) throw new NotFoundException('count was not found')
    return detail
  }

  @Post('stock-counts')
  @RequireInventoryAction('manage')
  async openCount(@Body() body: unknown, @Req() request: InventoryRequest) {
    return unwrap(
      await this.runtime.openCount.execute({
        context: idempotent(request),
        ...parse(countInput, body),
      }),
    )
  }

  @Patch('stock-counts/:id/figures')
  @RequireInventoryAction('manage')
  @HttpCode(204)
  async recordCount(
    @Param('id') countId: string,
    @Body() body: unknown,
    @Req() request: InventoryRequest,
  ) {
    unwrap(
      await this.runtime.recordCount.execute({
        context: context(request),
        countId: id(countId),
        ...parse(countFiguresInput, body),
      }),
    )
  }

  @Patch('stock-counts/:id/close')
  @RequireInventoryAction('manage')
  async closeCount(@Param('id') countId: string, @Req() request: InventoryRequest) {
    return unwrap(
      await this.runtime.closeCount.execute({
        context: context(request),
        countId: id(countId),
      }),
    )
  }

  @Patch('stock-counts/:id/approve')
  @RequireInventoryAction('approve')
  async approveCount(@Param('id') countId: string, @Req() request: InventoryRequest) {
    return unwrap(
      await this.runtime.decideCount.execute({
        context: context(request),
        countId: id(countId),
        decision: { kind: 'approve' },
      }),
    )
  }

  @Patch('stock-counts/:id/reject')
  @RequireInventoryAction('approve')
  async rejectCount(
    @Param('id') countId: string,
    @Body() body: unknown,
    @Req() request: InventoryRequest,
  ) {
    return unwrap(
      await this.runtime.decideCount.execute({
        context: context(request),
        countId: id(countId),
        decision: { kind: 'reject', reason: parse(reasonInput, body).reason },
      }),
    )
  }

  @Patch('stock-counts/:id/cancel')
  @RequireInventoryAction('manage')
  async cancelCount(
    @Param('id') countId: string,
    @Body() body: unknown,
    @Req() request: InventoryRequest,
  ) {
    return unwrap(
      await this.runtime.decideCount.execute({
        context: context(request),
        countId: id(countId),
        decision: { kind: 'cancel', reason: parse(reasonInput, body).reason },
      }),
    )
  }

  // ---------------------------------------------------------------- policies

  @Get('adjustment-policies')
  @RequireInventoryAction('read')
  policies(@Req() request: InventoryRequest) {
    return this.runtime.database.listPolicies(tenantOf(request))
  }

  @Put('adjustment-policies')
  @RequireInventoryAction('approve')
  async definePolicy(@Body() body: unknown, @Req() request: InventoryRequest) {
    const policy = unwrap(
      await this.runtime.defineAdjustmentPolicy.execute({
        context: context(request),
        ...parse(policyInput, body),
      }),
    )
    return {
      currency: policy.currency,
      threshold: policy.threshold.toString(),
      updatedBy: policy.updatedBy,
      updatedAt: policy.updatedAt.toISOString(),
    }
  }
}
