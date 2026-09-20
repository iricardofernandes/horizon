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
import { asOfInstantOf, context, idempotent, pageOf, rangeOf } from './command-context'
import { id, parse, unwrap } from './request-parsing'

const quantity = z.string().regex(/^\d+(?:\.\d{1,6})?$/)
const amount = z.string().regex(/^\d+$/).max(30)
const currency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
const note = z.string().min(1).max(500)

const createWarehouseInput = z.strictObject({ name: z.string().min(1).max(120) })

const lotCode = z.string().min(1).max(60)
/** Goods arriving under a code, with the day they go off if anybody said. */
const lotEntries = z
  .array(z.strictObject({ code: lotCode, expiresOn: z.iso.date().nullish(), quantity }))
  .min(1)
  .max(200)
/** Which boxes to draw from, when the caller would rather choose than let the shelf. */
const lotPicks = z
  .array(z.strictObject({ code: lotCode, quantity }))
  .min(1)
  .max(200)

const receiveStockInput = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  quantity,
  unitCost: amount,
  currency,
  lots: lotEntries.nullish(),
})

const transferInput = z.strictObject({
  sourceWarehouseId: z.uuid(),
  destinationWarehouseId: z.uuid(),
  lines: z
    .array(z.strictObject({ itemId: z.uuid(), quantity, lots: lotPicks.nullish() }))
    .min(1)
    .max(200),
  note: note.nullish(),
})

const adjustmentInput = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  direction: z.enum(['in', 'out']),
  lot: lotCode.nullish(),
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
    .array(z.strictObject({ itemId: z.uuid(), lot: lotCode.nullish(), counted: quantity }))
    .min(1)
    .max(2000),
})

const trackingInput = z.strictObject({
  itemId: z.uuid(),
  tracking: z.enum(['none', 'lot']),
  expiry: z.enum(['none', 'optional', 'required']).nullish(),
})

const lotFilter = z.object({
  warehouseId: z.uuid().nullish(),
  itemId: z.uuid().nullish(),
  expiringBy: z.iso.date().nullish(),
})

const traceFilter = z.object({ itemId: z.uuid() })

const levelInput = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  minimum: quantity,
  maximum: quantity.nullish(),
})

const kardexFilter = z.object({ itemId: z.uuid(), warehouseId: z.uuid() })
const scopeFilter = z.object({ warehouseId: z.uuid().nullish(), itemId: z.uuid().nullish() })
// Where the A band stops and the B band stops, as whole percentages of the period's value.
const abcFilter = z.object({
  a: z.coerce.number().int().min(1).max(99).default(80),
  b: z.coerce.number().int().min(2).max(100).default(95),
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

  // ---------------------------------------------------------------- reports

  @Get('stock-ledger')
  @RequireInventoryAction('read')
  kardex(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(kardexFilter, query)
    return this.runtime.database.kardex(tenantOf(request), {
      ...filter,
      ...rangeOf(query),
      ...pageOf(query),
    })
  }

  @Get('stock-position')
  @RequireInventoryAction('read')
  position(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(scopeFilter, query)
    return this.runtime.database.stockPosition(tenantOf(request), {
      warehouseId: filter.warehouseId ?? null,
      itemId: filter.itemId ?? null,
      ...pageOf(query),
    })
  }

  @Get('stock-valuation')
  @RequireInventoryAction('read')
  valuation(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(scopeFilter, query)
    return this.runtime.database.valuation(tenantOf(request), {
      asOf: asOfInstantOf(query),
      warehouseId: filter.warehouseId ?? null,
    })
  }

  @Get('stock-alerts')
  @RequireInventoryAction('read')
  alerts(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(scopeFilter, query)
    return this.runtime.database.stockAlerts(tenantOf(request), {
      warehouseId: filter.warehouseId ?? null,
      ...pageOf(query),
    })
  }

  @Get('cost-of-goods-sold')
  @RequireInventoryAction('read')
  costOfGoodsSold(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(scopeFilter, query)
    return this.runtime.database.costOfGoodsSold(tenantOf(request), {
      ...rangeOf(query),
      warehouseId: filter.warehouseId ?? null,
    })
  }

  @Get('stock-abc')
  @RequireInventoryAction('read')
  abcCurve(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(scopeFilter, query)
    const thresholds = parse(abcFilter, query)
    if (thresholds.b <= thresholds.a) throw new BadRequestException('b: must be above a')
    return this.runtime.database.abcCurve(tenantOf(request), {
      ...rangeOf(query),
      warehouseId: filter.warehouseId ?? null,
      thresholds,
    })
  }

  // ---------------------------------------------------------------- lots

  @Get('stock-lots')
  @RequireInventoryAction('read')
  lots(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(lotFilter, query)
    return this.runtime.database.listLots(tenantOf(request), {
      warehouseId: filter.warehouseId ?? null,
      itemId: filter.itemId ?? null,
      expiringBy: filter.expiringBy ?? null,
      ...pageOf(query),
    })
  }

  @Get('stock-lots/:code/trace')
  @RequireInventoryAction('read')
  traceLot(@Param('code') code: string, @Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(traceFilter, query)
    return this.runtime.database.traceLot(tenantOf(request), {
      itemId: filter.itemId,
      code: parse(lotCode, code).trim().replace(/\s+/g, ' ').toUpperCase(),
      ...pageOf(query),
    })
  }

  // ---------------------------------------------------------------- tracking

  @Get('item-tracking')
  @RequireInventoryAction('read')
  async tracking(@Req() request: InventoryRequest) {
    const items = await this.runtime.database.listTracking(tenantOf(request))
    return items.map((item) => ({
      itemId: item.itemId,
      tracking: item.tracking.kind,
      expiry: item.tracking.expiry,
      updatedBy: item.updatedBy,
      updatedAt: item.updatedAt.toISOString(),
    }))
  }

  @Put('item-tracking')
  @RequireInventoryAction('manage')
  async defineTracking(@Body() body: unknown, @Req() request: InventoryRequest) {
    const input = parse(trackingInput, body)
    const item = unwrap(
      await this.runtime.defineItemTracking.execute({
        context: context(request),
        itemId: input.itemId,
        tracking: input.tracking,
        expiry: input.expiry ?? 'none',
      }),
    )
    return {
      itemId: item.itemId,
      tracking: item.tracking.kind,
      expiry: item.tracking.expiry,
      updatedBy: item.updatedBy,
      updatedAt: item.updatedAt.toISOString(),
    }
  }

  // ---------------------------------------------------------------- levels

  @Get('stock-levels')
  @RequireInventoryAction('read')
  levels(@Query() query: unknown, @Req() request: InventoryRequest) {
    const filter = parse(scopeFilter, query)
    return this.runtime.database.listLevels(tenantOf(request), {
      warehouseId: filter.warehouseId ?? null,
      ...pageOf(query),
    })
  }

  @Put('stock-levels')
  @RequireInventoryAction('manage')
  async defineLevel(@Body() body: unknown, @Req() request: InventoryRequest) {
    const input = parse(levelInput, body)
    const level = unwrap(
      await this.runtime.defineStockLevel.execute({
        context: context(request),
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        minimum: input.minimum,
        maximum: input.maximum ?? null,
      }),
    )
    return {
      warehouseId: level.warehouseId,
      itemId: level.itemId,
      minimum: level.minimum.toString(),
      maximum: level.maximum?.toString() ?? null,
      updatedBy: level.updatedBy,
      updatedAt: level.updatedAt.toISOString(),
    }
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
