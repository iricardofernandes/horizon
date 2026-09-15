import { Controller, Get, Inject, Req } from '@nestjs/common'
import { InventoryRuntime } from '@/main/inventory-runtime'
import {
  type InventoryRequest,
  PublicRoute,
  RequireInventoryAction,
  tenantOf,
} from './authorization'

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
}
