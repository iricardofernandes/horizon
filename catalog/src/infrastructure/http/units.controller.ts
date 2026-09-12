import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { RequestSchema } from './api-schema'
import { ReadDuringDenylistOutage, RequirePermission } from './authorization'
import { auditOf, type CatalogHttpRequest, tenantOf } from './http-context'
import { presentPage, presentUnit, unwrap } from './presenters'
import { listRequest } from './query'

const createUnit = z.strictObject({
  code: z.string().min(1).max(6),
  name: z.string().min(1).max(160),
  decimalPlaces: z.number().int().min(0).max(6),
})

@Controller('units')
@ApiTags('units')
export class UnitsController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  @Get()
  @RequirePermission('read', 'Units')
  @ReadDuringDenylistOutage()
  async list(@Query() query: unknown, @Req() request: CatalogHttpRequest) {
    const page = unwrap(await this.runtime.listUnits.execute(listRequest(query, tenantOf(request))))
    return presentPage(page, presentUnit)
  }

  @Post()
  @RequestSchema(createUnit)
  @RequirePermission('manage', 'Units')
  async create(@Body() body: unknown, @Req() request: CatalogHttpRequest) {
    const input = createUnit.parse(body)
    return unwrap(
      await this.runtime.createUnit.execute({
        ...input,
        tenantId: tenantOf(request),
        ...auditOf(request),
      }),
    )
  }
}
