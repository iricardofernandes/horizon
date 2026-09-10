import { moduleNameSchema } from '@horizon/contracts'
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'

import { IdentityRuntime } from '@/main/identity-runtime'
import { RequestSchema } from './api-schema'
import { RequirePermission } from './authorization'
import { actor, type IdentityHttpRequest, principal, requestMetadata } from './http-context'
import { presentApiKey, presentUser, unwrap } from './presenters'

const scope = z.templateLiteral([moduleNameSchema, ':', z.enum(['read', 'write'])])
const createApiKey = z.strictObject({
  name: z.string().min(1).max(200),
  scopes: scope.array().min(1).max(50),
  expiresAt: z.iso.datetime().optional(),
})
const rotateApiKey = z.strictObject({ overlapSeconds: z.number().int().min(0).max(604_800) })

@Controller()
@ApiBearerAuth()
@ApiTags('administration')
export class AdministrationController {
  constructor(@Inject(IdentityRuntime) private readonly runtime: IdentityRuntime) {}

  @Post('api-keys')
  @RequestSchema(createApiKey)
  @Header('Cache-Control', 'no-store')
  async createApiKey(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const input = createApiKey.parse(body)
    return unwrap(
      await this.runtime.createApiKey.execute({
        name: input.name,
        scopes: input.scopes,
        ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
        tenantId: principal(request).tenantId,
        issuedBy: principal(request).subject,
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }

  @Post('api-keys/:apiKeyId/rotate')
  @RequestSchema(rotateApiKey)
  @RequirePermission('manage', 'ApiKeys')
  @Header('Cache-Control', 'no-store')
  async rotateApiKey(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: unknown,
    @Req() request: IdentityHttpRequest,
  ) {
    const input = rotateApiKey.parse(body)
    return unwrap(
      await this.runtime.rotateApiKey.execute({
        ...input,
        tenantId: principal(request).tenantId,
        apiKeyId: z.uuid().parse(apiKeyId),
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }

  @Delete('api-keys/:apiKeyId')
  @RequirePermission('manage', 'ApiKeys')
  @HttpCode(204)
  async revokeApiKey(@Param('apiKeyId') apiKeyId: string, @Req() request: IdentityHttpRequest) {
    unwrap(
      await this.runtime.revokeApiKey.execute({
        tenantId: principal(request).tenantId,
        apiKeyId: z.uuid().parse(apiKeyId),
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }

  @Get('data-subjects/:subjectId/export')
  @RequirePermission('read', 'DataSubjects')
  @Header('Cache-Control', 'no-store')
  async exportSubject(@Param('subjectId') subjectId: string, @Req() request: IdentityHttpRequest) {
    const result = unwrap(
      await this.runtime.exportDataSubject.execute({
        tenantId: principal(request).tenantId,
        subjectId: z.uuid().parse(subjectId),
      }),
    )
    return { user: presentUser(result.user), apiKeys: result.apiKeys.map(presentApiKey) }
  }

  @Delete('data-subjects/:subjectId')
  @RequirePermission('manage', 'DataSubjects')
  @HttpCode(204)
  async eraseSubject(@Param('subjectId') subjectId: string, @Req() request: IdentityHttpRequest) {
    unwrap(
      await this.runtime.eraseDataSubject.execute({
        tenantId: principal(request).tenantId,
        subjectId: z.uuid().parse(subjectId),
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }

  @Get('audit/verify')
  @RequirePermission('read', 'Audit')
  @Header('Cache-Control', 'no-store')
  async verifyAudit(@Req() request: IdentityHttpRequest) {
    return unwrap(
      await this.runtime.verifyAuditChain.execute({ tenantId: principal(request).tenantId }),
    )
  }
}
