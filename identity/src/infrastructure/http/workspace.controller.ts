import { Body, Controller, Get, Header, Inject, Put, Req } from '@nestjs/common'
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
  addressState: optionalText,
  addressPostalCode: optionalText,
  addressCountry: z.string().trim().length(2).nullish(),
  baseCurrency: z.string().trim().length(3),
  fiscalRegime: z.enum(FISCAL_REGIMES),
  timezone: z.string().trim().min(1).max(64),
})

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
    const { timezone, ...company } = describeCompany.parse(body)
    const result = unwrap(
      await this.runtime.describeCompany.execute({
        tenantId: principal(request).tenantId,
        company,
        timezone,
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
    return presentWorkspace(result.tenant)
  }
}
