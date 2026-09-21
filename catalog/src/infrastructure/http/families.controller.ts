import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { RequestSchema } from './api-schema'
import { ReadDuringDenylistOutage, RequirePermission } from './authorization'
import { auditOf, type CatalogHttpRequest, tenantOf } from './http-context'
import { presentPage, unwrap } from './presenters'
import { listRequest } from './query'

const attribute = z.string().min(1).max(60)

const defineFamily = z.strictObject({
  name: z.string().min(1).max(160),
  /** Ordered, and fixed once anything is in the family. */
  attributes: z.array(attribute).min(1).max(8),
})

const assignVariant = z.strictObject({
  familyId: z.uuid(),
  values: z
    .array(z.strictObject({ attribute, value: z.string().min(1).max(120) }))
    .min(1)
    .max(8),
})

const page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

@Controller('families')
@ApiTags('families')
export class FamiliesController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  @Get()
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  async list(@Query() query: unknown, @Req() request: CatalogHttpRequest) {
    const found = await this.runtime.listFamilies.execute(listRequest(query, tenantOf(request)))
    return presentPage(unwrap(found), (family) => family.toSnapshot())
  }

  @Post()
  @RequestSchema(defineFamily)
  @RequirePermission('manage', 'Items')
  async define(@Body() body: unknown, @Req() request: CatalogHttpRequest) {
    const input = defineFamily.parse(body)
    return unwrap(
      await this.runtime.defineFamily.execute({
        tenantId: tenantOf(request),
        ...auditOf(request),
        name: input.name,
        attributes: input.attributes,
      }),
    )
  }

  /** The items in a family, each with the answers that tell it from its siblings. */
  @Get(':familyId/variants')
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  variants(
    @Param('familyId') familyId: string,
    @Query() query: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    return this.runtime.database.listVariants(tenantOf(request), {
      familyId: z.uuid().parse(familyId),
      ...page.parse(query),
    })
  }

  /**
   * An item takes its place in a family.
   *
   * A `PUT` because restating the same family and the same answers changes nothing: the
   * item is already that variant, and saying so again is not a second event.
   */
  @Put('variants/:itemId')
  @RequestSchema(assignVariant)
  @RequirePermission('manage', 'Items')
  async assign(
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    const input = assignVariant.parse(body)
    return unwrap(
      await this.runtime.assignVariant.execute({
        tenantId: tenantOf(request),
        ...auditOf(request),
        itemId: z.uuid().parse(itemId),
        familyId: input.familyId,
        values: input.values,
      }),
    )
  }
}
