import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'

import { FISCAL_REGIMES } from '@/domain/value-objects/company-profile'
import { IdentityRuntime } from '@/main/identity-runtime'
import { RequestSchema } from './api-schema'
import { RequirePermission } from './authorization'
import { actor, type IdentityHttpRequest, principal, requestMetadata } from './http-context'
import { presentWorkspace, unwrap } from './presenters'

const optionalText = z.string().trim().max(200).nullish()

const describeCompany = z.strictObject({
  legalName: z.string().trim().min(2).max(200),
  tradeName: optionalText,
  taxId: optionalText,
  stateRegistration: optionalText,
  municipalRegistration: optionalText,
  addressLine: z.string().trim().max(500).nullish(),
  addressCity: optionalText,
  addressMunicipalityCode: z
    .string()
    .trim()
    .regex(/^\d{7}$/)
    .nullish(),
  addressState: optionalText,
  addressPostalCode: optionalText,
  addressCountry: z.string().trim().length(2).nullish(),
  baseCurrency: z.string().trim().length(3),
  fiscalRegime: z.enum(FISCAL_REGIMES),
  fiscalEffectiveFrom: z.iso.date().optional(),
  timezone: z.string().trim().min(1).max(64),
})

function requireFiscalReader(request: IdentityHttpRequest): void {
  const assigned = principal(request).roles.some(
    (role) => role.module === 'identity' && role.role === 'fiscal-reader',
  )
  if (!assigned) throw new ForbiddenException('Fiscal profile reader role required')
}

/**
 * The company the workspace legally is. Every member may read it — currency, timezone and
 * regime shape what they see — and only an Identity owner may change it.
 */
@Controller('workspace')
@ApiBearerAuth()
@ApiTags('workspace')
export class WorkspaceController {
  constructor(@Inject(IdentityRuntime) private readonly runtime: IdentityRuntime) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async read(@Req() request: IdentityHttpRequest) {
    const result = unwrap(
      await this.runtime.readWorkspace.execute({ tenantId: principal(request).tenantId }),
    )
    return presentWorkspace(result.tenant)
  }

  @Put('company')
  @RequestSchema(describeCompany)
  @RequirePermission('manage', 'Workspace')
  @Header('Cache-Control', 'no-store')
  async describe(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const { timezone, fiscalEffectiveFrom, ...company } = describeCompany.parse(body)
    const result = unwrap(
      await this.runtime.describeCompany.execute({
        tenantId: principal(request).tenantId,
        company,
        timezone,
        fiscalEffectiveFrom,
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
    return presentWorkspace(result.tenant)
  }

  @Get('company/fiscal-profile/:revision')
  @Header('Cache-Control', 'no-store')
  async fiscalProfile(@Param('revision') revision: string, @Req() request: IdentityHttpRequest) {
    requireFiscalReader(request)
    const parsed = z.coerce.number().int().positive().safeParse(revision)
    if (!parsed.success) throw new BadRequestException('Invalid fiscal profile revision')
    const profile = await this.runtime.database.findCompanyFiscalExport(
      principal(request).tenantId,
      parsed.data,
    )
    if (!profile) throw new NotFoundException('Fiscal profile was not found')
    return profile
  }

  @Get('company/fiscal-profiles')
  @Header('Cache-Control', 'no-store')
  async fiscalProfileRevisions(@Req() request: IdentityHttpRequest) {
    requireFiscalReader(request)
    const result = unwrap(
      await this.runtime.readWorkspace.execute({ tenantId: principal(request).tenantId }),
    )
    const revision = result.tenant.toSnapshot().fiscalProfileRevision
    return { tenantId: principal(request).tenantId, data: revision > 0 ? [{ revision }] : [] }
  }
}
