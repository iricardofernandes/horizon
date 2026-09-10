import { Body, Controller, Header, HttpCode, Inject, Post, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'

import { IdentityRuntime } from '@/main/identity-runtime'
import { RequestSchema } from './api-schema'
import { PublicRoute } from './authorization'
import { type IdentityHttpRequest, principal, requestMetadata } from './http-context'
import { IdempotencySignup, SkipIdempotency } from './idempotency-interceptor'
import { unwrap } from './presenters'

const password = z.string().min(12).max(1024)
const signup = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80),
  timezone: z.string().min(1).max(100),
  owner: z.strictObject({ email: z.email().max(254), name: z.string().min(1).max(200), password }),
})
const login = z.strictObject({
  tenantSlug: z.string().min(1).max(80),
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
})
const refresh = z.strictObject({
  tenantId: z.uuid(),
  familyId: z.uuid(),
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})
const logout = z.strictObject({ familyId: z.uuid() })
const apiKey = z.strictObject({ tenantId: z.uuid(), presented: z.string().min(1).max(256) })

@Controller('auth')
@ApiTags('authentication')
export class AuthController {
  constructor(@Inject(IdentityRuntime) private readonly runtime: IdentityRuntime) {}

  @Post('signup')
  @RequestSchema(signup)
  @PublicRoute()
  @IdempotencySignup()
  @Header('Cache-Control', 'no-store')
  async signup(@Body() body: unknown) {
    return unwrap(await this.runtime.createTenant.execute(signup.parse(body)))
  }

  @Post('login')
  @RequestSchema(login)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    return unwrap(
      await this.runtime.authenticateUser.execute({
        ...login.parse(body),
        ...requestMetadata(request),
      }),
    )
  }

  @Post('refresh')
  @RequestSchema(refresh)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async refresh(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    return unwrap(
      await this.runtime.refreshSession.execute({
        ...refresh.parse(body),
        ...requestMetadata(request),
      }),
    )
  }

  @Post('logout')
  @RequestSchema(logout)
  @ApiBearerAuth()
  @HttpCode(204)
  async logout(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const { familyId } = logout.parse(body)
    const claims = principal(request)
    unwrap(
      await this.runtime.revokeSession.execute({
        tenantId: claims.tenantId,
        userId: claims.subject,
        jti: claims.jti,
        accessTokenExpiresAt: claims.expiresAt,
        familyId,
        requestId: request.id ?? null,
      }),
    )
  }

  @Post('api-key')
  @RequestSchema(apiKey)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async authenticateApiKey(@Body() body: unknown) {
    const input = apiKey.parse(body)
    return unwrap(await this.runtime.authenticateApiKey.execute(input))
  }
}
