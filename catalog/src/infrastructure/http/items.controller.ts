import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { RequestSchema } from './api-schema'
import { ReadDuringDenylistOutage, RequirePermission } from './authorization'
import { type CatalogHttpRequest, tenantOf } from './http-context'
import { presentItem, presentPage, unwrap } from './presenters'
import { listRequest } from './query'

const createItem = z.strictObject({
  kind: z.enum(['product', 'service']),
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  unitId: z.uuid(),
  // Eight digits, however the client spaces or dots them: "0901.21.00" is how an NCM
  // code is written on a Brazilian invoice, and the domain normalizes it.
  ncm: z
    .string()
    .regex(/^[\d.\s]{8,16}$/)
    .refine((value) => /^\d{8}$/.test(value.replace(/[.\s]/g, '')), 'must contain exactly 8 digits')
    .nullish(),
})

@Controller('items')
@ApiTags('items')
export class ItemsController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  @Get()
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  async list(@Query() query: unknown, @Req() request: CatalogHttpRequest) {
    const page = unwrap(await this.runtime.listItems.execute(listRequest(query, tenantOf(request))))
    return presentPage(page, presentItem)
  }

  @Post()
  @RequestSchema(createItem)
  @RequirePermission('manage', 'Items')
  async create(@Body() body: unknown, @Req() request: CatalogHttpRequest) {
    const input = createItem.parse(body)
    return unwrap(
      await this.runtime.createItem.execute({
        tenantId: tenantOf(request),
        kind: input.kind,
        sku: input.sku,
        name: input.name,
        unitId: input.unitId,
        ...(input.ncm === undefined ? {} : { ncm: input.ncm }),
      }),
    )
  }

  /** Deactivation, not deletion: documents already referencing the item stay valid. */
  @Patch(':itemId/deactivate')
  @RequirePermission('manage', 'Items')
  @HttpCode(204)
  async deactivate(@Param('itemId') itemId: string, @Req() request: CatalogHttpRequest) {
    unwrap(
      await this.runtime.deactivateItem.execute({
        tenantId: tenantOf(request),
        itemId: z.uuid().parse(itemId),
      }),
    )
  }
}
