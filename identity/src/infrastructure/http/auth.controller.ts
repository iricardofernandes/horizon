import { Body, Controller, Header, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'

import { IdentityRuntime } from '@/main/identity-runtime'
import { recordExchange } from './api-key-exchanges'
import { RequestSchema } from './api-schema'
import { PublicRoute } from './authorization'
import { type IdentityHttpRequest, principal, requestMetadata } from './http-context'
import { IdempotencySignup, SkipIdempotency } from './idempotency-interceptor'
import { presentExchange, unwrap } from './presenters'

const password = z.string().min(12).max(1024)
const signup = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80),
  timezone: z.string().min(1).max(100),
  owner: z.strictObject({ email: z.email().max(254), name: z.string().min(1).max(200), password }),
})
const login = z.strictObject({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
})
const workspaceSelection = z.strictObject({
  selectionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})
const selectWorkspace = workspaceSelection.extend({ tenantId: z.uuid() })
const refresh = z.strictObject({
  tenantId: z.uuid(),
  familyId: z.uuid(),
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})
const logout = z.strictObject({ familyId: z.uuid() })
const apiKey = z.strictObject({ tenantId: z.uuid(), presented: z.string().min(1).max(256) })
const serviceToken = z.strictObject({
  client: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  secret: z.string().min(32).max(256),
  tenantId: z.uuid(),
})

@Controller('auth')
@ApiTags('authentication')
export class AuthController {
  private readonly logger = new Logger(AuthController.name)

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
  async login(@Body() body: unknown) {
    return unwrap(
      await this.runtime.authenticateAccount.execute({
        ...login.parse(body),
      }),
    )
  }

  @Post('workspaces')
  @RequestSchema(workspaceSelection)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async workspaces(@Body() body: unknown) {
    return unwrap(
      await this.runtime.listSelectableWorkspaces.execute(
        workspaceSelection.parse(body).selectionToken,
      ),
    )
  }

  @Post('workspace')
  @RequestSchema(selectWorkspace)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async workspace(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const input = selectWorkspace.parse(body)
    const userAgent = request.headers['user-agent']
    return unwrap(
      await this.runtime.selectWorkspace.execute({
        ...input,
        ...requestMetadata(request),
        userAgent: typeof userAgent === 'string' ? userAgent : null,
      }),
    )
  }

  @Post('workspace-selection')
  @ApiBearerAuth()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async beginWorkspaceSwitch(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    return unwrap(
      await this.runtime.beginWorkspaceSwitch.execute({
        tenantId: claims.tenantId,
        userId: claims.subject,
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
    // The token asking dies whatever happens; the session's other live tokens die with it.
    await this.runtime.denylist.revoke(claims.jti, claims.expiresAt)
    unwrap(
      await this.runtime.sessions.end(
        claims.tenantId,
        claims.subject,
        familyId,
        { type: 'user', id: claims.subject },
        request.id ?? null,
      ),
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

  /** Scheduled work in one tenant, for a named service client (Phase 69). */
  @Post('service-token')
  @RequestSchema(serviceToken)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async serviceToken(@Body() body: unknown) {
    const input = serviceToken.parse(body)
    const issued = unwrap(await this.runtime.issueServiceToken.execute(input))
    return { ...issued, accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString() }
  }

  /** A key exchanged for a 60-second token that carries its scopes (ADR 0064). */
  @Post('api-key/token')
  @RequestSchema(apiKey)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async apiKeyToken(@Body() body: unknown) {
    const request = apiKey.parse(body)
    const result = await this.runtime.exchangeApiKey.forKey(request)
    recordExchange(result, request.presented, this.logger)
    return presentExchange(unwrap(result))
  }

  /** The fiscal worker's reader token, one case of the same exchange. */
  @Post('fiscal-token')
  @RequestSchema(apiKey)
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async fiscalToken(@Body() body: unknown) {
    const request = apiKey.parse(body)
    const result = await this.runtime.exchangeApiKey.forFiscalReader(request)
    recordExchange(result, request.presented, this.logger)
    const exchanged = unwrap(result)
    return {
      tenantId: exchanged.tenantId,
      accessToken: exchanged.accessToken,
      expiresAt: exchanged.expiresAt.toISOString(),
    }
  }
}
