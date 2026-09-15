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

const createWarehouseInput = z.strictObject({ name: z.string().min(1).max(120) })
const receiveStockInput = z.strictObject({
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  unitCost: z.string().regex(/^\d+$/).max(30),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/),
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
  async deactivateWarehouse(@Param('id') id: string, @Req() request: InventoryRequest) {
    const parsed = z.uuid().safeParse(id)
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
}
