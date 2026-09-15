import {
  BadRequestException,
  Body,
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
