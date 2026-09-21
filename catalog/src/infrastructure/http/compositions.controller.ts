import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { RequestSchema } from './api-schema'
import { ReadDuringDenylistOutage, RequirePermission } from './authorization'
import { auditOf, type CatalogHttpRequest, tenantOf } from './http-context'
import { unwrap } from './presenters'

const defineComposition = z.strictObject({
  /**
   * `assembled` is a recipe: the parent is stocked and something makes it out of these.
   * `exploded` is a bundle: the parent is never stocked and stands for what is under it.
   */
  realisation: z.enum(['assembled', 'exploded']),
  effectiveFrom: z.iso.date(),
  lines: z
    .array(
      z.strictObject({
        componentItemId: z.uuid(),
        quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
      }),
    )
    .min(1)
    .max(200),
})

const asOf = z.object({
  on: z.iso.date().optional(),
  /** Only the things somebody actually has to have in a warehouse. */
  leavesOnly: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
})

const today = () => new Date().toISOString().slice(0, 10)

@Controller('items/:itemId/composition')
@ApiTags('compositions')
export class CompositionsController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  /** What this item is made of on a given day; the latest version whose date has come. */
  @Get()
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  async inForce(
    @Param('itemId') itemId: string,
    @Query() query: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    const found = await this.runtime.database.compositionInForce(tenantOf(request), {
      parentItemId: z.uuid().parse(itemId),
      on: asOf.parse(query).on ?? today(),
    })
    if (!found) throw new NotFoundException('this item is not made of anything on that day')
    return found
  }

  /** Everything one of it needs, all the way down, with the levels multiplied through. */
  @Get('explosion')
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  explosion(
    @Param('itemId') itemId: string,
    @Query() query: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    const filter = asOf.parse(query)
    return this.runtime.database.explodeComposition(tenantOf(request), {
      parentItemId: z.uuid().parse(itemId),
      on: filter.on ?? today(),
      leavesOnly: filter.leavesOnly,
    })
  }

  /** Superseding, never editing: a recipe that changed keeps the one it replaced. */
  @Post()
  @RequestSchema(defineComposition)
  @RequirePermission('manage', 'Items')
  async define(
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    const input = defineComposition.parse(body)
    return unwrap(
      await this.runtime.defineComposition.execute({
        tenantId: tenantOf(request),
        ...auditOf(request),
        parentItemId: z.uuid().parse(itemId),
        realisation: input.realisation,
        effectiveFrom: input.effectiveFrom,
        lines: input.lines,
      }),
    )
  }
}
