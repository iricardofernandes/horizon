import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
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
import { auditOf, type CatalogHttpRequest, tenantOf } from './http-context'
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
const classifyItem = z.strictObject({
  effectiveFrom: z.iso.date(),
  ncm: z
    .string()
    .regex(/^\d{8}$/)
    .nullable(),
})
const classificationList = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.uuid().optional(),
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

  @Get('classifications')
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  async listClassifications(@Query() query: unknown, @Req() request: CatalogHttpRequest) {
    const parsed = classificationList.parse(query)
    return this.runtime.database.listClassificationRevisions(
      tenantOf(request),
      parsed.limit,
      parsed.cursor,
    )
  }

  @Post()
  @RequestSchema(createItem)
  @RequirePermission('manage', 'Items')
  async create(@Body() body: unknown, @Req() request: CatalogHttpRequest) {
    const input = createItem.parse(body)
    return unwrap(
      await this.runtime.createItem.execute({
        tenantId: tenantOf(request),
        ...auditOf(request),
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
        ...auditOf(request),
        itemId: z.uuid().parse(itemId),
      }),
    )
  }

  @Patch(':itemId/classification')
  @RequestSchema(classifyItem)
  @RequirePermission('manage', 'Items')
  async classify(
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Req() request: CatalogHttpRequest,
  ) {
    const input = classifyItem.parse(body)
    return unwrap(
      await this.runtime.classifyItem.execute({
        tenantId: tenantOf(request),
        ...auditOf(request),
        itemId: z.uuid().parse(itemId),
        ...input,
      }),
    )
  }

  @Get(':itemId/classification/:revision')
  @RequirePermission('read', 'Items')
  @ReadDuringDenylistOutage()
  async classification(
    @Param('itemId') itemId: string,
    @Param('revision') revision: string,
    @Req() request: CatalogHttpRequest,
  ) {
    const parsed = z.coerce.number().int().positive().parse(revision)
    const result = await this.runtime.database.classificationRevision(
      tenantOf(request),
      z.uuid().parse(itemId),
      parsed,
    )
    if (!result) throw new NotFoundException('Classification revision was not found')
    return result
  }
}
