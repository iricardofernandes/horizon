import { cursorPayloadSchema, roleAssignmentSchema } from '@horizon/contracts'
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'

import { IdentityRuntime } from '@/main/identity-runtime'
import { RequestSchema } from './api-schema'
import { ReadDuringDenylistOutage, RequirePermission } from './authorization'
import { actor, type IdentityHttpRequest, principal, requestMetadata } from './http-context'
import { presentApiKey, presentSelf, presentUser, unwrap } from './presenters'

const cursor = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const bytes = Buffer.from(value, 'base64url')
      return (
        bytes.toString('base64url') === value &&
        cursorPayloadSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success
      )
    } catch {
      return false
    }
  }, 'cursor is invalid')

const registerUser = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(200),
  password: z.string().min(12).max(1024),
  roles: roleAssignmentSchema.array().max(50).default([]),
})
const assignRole = z.strictObject({
  assignment: roleAssignmentSchema,
  operation: z.enum(['grant', 'revoke']),
})
const choosePreferences = z.strictObject({ preferredLocale: z.string().trim().min(2).max(35) })

@Controller()
@ApiBearerAuth()
@ApiTags('users')
export class UsersController {
  constructor(@Inject(IdentityRuntime) private readonly runtime: IdentityRuntime) {}

  @Get('me')
  @ReadDuringDenylistOutage()
  @Header('Cache-Control', 'no-store')
  async me(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    const result = unwrap(
      await this.runtime.exportDataSubject.execute({
        tenantId: claims.tenantId,
        subjectId: claims.subject,
      }),
    )
    return presentSelf(result.user, await this.runtime.accountOf(claims.tenantId, claims.subject))
  }

  /** The reader's language, stored on the global account rather than this membership. */
  @Patch('me/preferences')
  @RequestSchema(choosePreferences)
  @Header('Cache-Control', 'no-store')
  async choosePreferences(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const input = choosePreferences.parse(body)
    const claims = principal(request)
    return unwrap(
      await this.runtime.choosePreferredLocale.execute({
        tenantId: claims.tenantId,
        userId: claims.subject,
        locale: input.preferredLocale,
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }

  @Get('me/export')
  @Header('Cache-Control', 'no-store')
  async exportSelf(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    const result = unwrap(
      await this.runtime.exportDataSubject.execute({
        tenantId: claims.tenantId,
        subjectId: claims.subject,
      }),
    )
    return { user: presentUser(result.user), apiKeys: result.apiKeys.map(presentApiKey) }
  }

  @Get('users')
  @RequirePermission('read', 'Users')
  @Header('Cache-Control', 'no-store')
  async list(@Query() query: unknown, @Req() request: IdentityHttpRequest) {
    const input = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: cursor.optional(),
      })
      .parse(query)
    const page = unwrap(
      await this.runtime.listUsers.execute({
        tenantId: principal(request).tenantId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    )
    return {
      data: page.items.map(presentUser),
      page: {
        hasMore: page.hasMore,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
    }
  }

  @Get('users/:userId')
  @RequirePermission('read', 'Users')
  @Header('Cache-Control', 'no-store')
  async get(@Param('userId') userId: string, @Req() request: IdentityHttpRequest) {
    const result = unwrap(
      await this.runtime.exportDataSubject.execute({
        tenantId: principal(request).tenantId,
        subjectId: z.uuid().parse(userId),
      }),
    )
    return presentUser(result.user)
  }

  @Post('users')
  @RequestSchema(registerUser)
  @RequirePermission('manage', 'Roles')
  async register(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const input = registerUser.parse(body)
    return unwrap(
      await this.runtime.registerUser.execute({
        ...input,
        tenantId: principal(request).tenantId,
        actor: actor(request),
      }),
    )
  }

  @Patch('users/:userId/disable')
  @RequirePermission('manage', 'Users')
  @HttpCode(204)
  async disable(@Param('userId') userId: string, @Req() request: IdentityHttpRequest) {
    unwrap(
      await this.runtime.disableUser.execute({
        tenantId: principal(request).tenantId,
        userId: z.uuid().parse(userId),
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }

  @Post('users/:userId/roles')
  @RequestSchema(assignRole)
  @RequirePermission('manage', 'Roles')
  @HttpCode(200)
  async assignRole(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: IdentityHttpRequest,
  ) {
    const input = assignRole.parse(body)
    return unwrap(
      await this.runtime.assignRole.execute({
        ...input,
        tenantId: principal(request).tenantId,
        userId: z.uuid().parse(userId),
        actor: actor(request),
        ...requestMetadata(request),
      }),
    )
  }
}
