import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { RequestSchema } from './api-schema'
import { ReadDuringDenylistOutage, RequirePermission } from './authorization'
import { auditOf, type CatalogHttpRequest, tenantOf } from './http-context'
import { presentPage, presentPriceList, unwrap } from './presenters'
import { listRequest } from './query'

const createPriceList = z.strictObject({
  name: z.string().min(1).max(160),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/),
})

/** Minor units as a string: the stored value is a bigint, which JSON cannot carry and
 * a float would silently round (ADR 0010). */
const setPriceBody = z.strictObject({
  amount: z.string().regex(/^\d+$/).max(30),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/),
})

@Controller('price-lists')
@ApiTags('price-lists')
export class PriceListsController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  @Get()
  @RequirePermission('read', 'PriceLists')
  @ReadDuringDenylistOutage()
  async list(@Query() query: unknown, @Req() request: CatalogHttpRequest) {
    const page = unwrap(
      await this.runtime.listPriceLists.execute(listRequest(query, tenantOf(request))),
    )
    return presentPage(page, presentPriceList)
  }

  @Post()
  @RequestSchema(createPriceList)
  @RequirePermission('manage', 'PriceLists')
  async create(@Body() body: unknown, @Req() request: CatalogHttpRequest) {
    const input = createPriceList.parse(body)
    return unwrap(
      await this.runtime.createPriceList.execute({
        ...input,
        tenantId: tenantOf(request),
        ...auditOf(request),
      }),
    )
  }

  @Put(':priceListId/prices/:itemId')
  @RequestSchema(setPriceBody)
  @RequirePermission('manage', 'Prices')
  @HttpCode(204)
  async setPrice(
    @Param('priceListId') priceListId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    const input = setPriceBody.parse(body)
    unwrap(
      await this.runtime.setPrice.execute({
        ...input,
        tenantId: tenantOf(request),
        ...auditOf(request),
        priceListId: z.uuid().parse(priceListId),
        itemId: z.uuid().parse(itemId),
      }),
    )
  }
}
