import { roleAssignmentSchema } from '@horizon/contracts'
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { z } from 'zod'
import { IdentityRuntime } from '@/main/identity-runtime'
import { PublicRoute, RequirePermission, RequireRecentAuth } from './authorization'
import { actor, type IdentityHttpRequest, principal } from './http-context'
import { SkipIdempotency } from './idempotency-interceptor'
import { unwrap } from './presenters'

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const codeMethod = z.enum(['totp', 'recovery'])
const code = z.string().trim().min(6).max(20)
const mfaCode = z.strictObject({ challengeToken: token, method: codeMethod, code })
const challengeOnly = z.strictObject({ challengeToken: token })
const passkeyAnswer = z.strictObject({
  challengeToken: token,
  response: z.record(z.string(), z.unknown()),
})
const enrollmentStart = z.strictObject({ enrollmentToken: token })
const enrollmentConfirm = z.strictObject({ enrollmentToken: token, factorId: z.uuid(), code })
const stepUp = z.strictObject({
  password: z.string().min(1).max(1024),
  method: codeMethod.optional(),
  code: code.optional(),
})
const confirmTotp = z.strictObject({ code })
const passkeyRegistration = z.strictObject({
  response: z.record(z.string(), z.unknown()),
  label: z.string().max(60).default('Passkey'),
})
const invite = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(200),
  roles: z.array(roleAssignmentSchema).min(1).max(50),
})
const invitationToken = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/)
const accept = z.strictObject({
  token: invitationToken,
  name: z.string().max(200).default(''),
  password: z.string().min(12).max(1024),
})
const policyInput = z.strictObject({
  policy: z.enum(['off', 'admins', 'everyone']),
  graceDays: z.number().int().min(0).max(30),
})

function context(request: IdentityHttpRequest) {
  return {
    tenantId: principal(request).tenantId,
    actor: actor(request),
    requestId: request.id ?? null,
  }
}

/**
 * Invitations, second factors, step-up and sessions (ADR 0061, Phase 67). Codes, secrets and
 * tokens are never logged or audited; audit entries name what changed and who changed it.
 */
@Controller()
@ApiTags('access')
export class AccessController {
  constructor(@Inject(IdentityRuntime) private readonly runtime: IdentityRuntime) {}

  // --- signing in with a second factor -------------------------------------------------

  @Post('auth/mfa')
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async secondFactor(@Body() body: unknown) {
    const input = mfaCode.parse(body)
    return unwrap(
      await this.runtime.completeSignIn.withCode(input.challengeToken, input.method, input.code),
    )
  }

  @Post('auth/mfa/passkey/options')
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async passkeySignInOptions(@Body() body: unknown) {
    return unwrap(
      await this.runtime.completeSignIn.passkeyOptions(challengeOnly.parse(body).challengeToken),
    )
  }

  @Post('auth/mfa/passkey')
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async passkeySignIn(@Body() body: unknown) {
    const input = passkeyAnswer.parse(body)
    return unwrap(
      await this.runtime.completeSignIn.withPasskey(input.challengeToken, input.response),
    )
  }

  /** Only when the workspace requires a factor and the grace period ended. */
  @Post('auth/enrollment/totp')
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async enrollmentStart(@Body() body: unknown) {
    const input = enrollmentStart.parse(body)
    return unwrap(
      await this.runtime.enrollWithToken.start(input.enrollmentToken, 'Horizon account'),
    )
  }

  @Post('auth/enrollment/totp/confirm')
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async enrollmentConfirm(@Body() body: unknown) {
    const input = enrollmentConfirm.parse(body)
    return unwrap(
      await this.runtime.enrollWithToken.confirm(input.enrollmentToken, input.factorId, input.code),
    )
  }

  // --- step-up and sessions --------------------------------------------------------------

  @Post('auth/step-up')
  @ApiBearerAuth()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async stepUp(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const input = stepUp.parse(body)
    const claims = principal(request)
    return unwrap(
      await this.runtime.stepUp.execute({
        tenantId: claims.tenantId,
        userId: claims.subject,
        sid: claims.sid ?? null,
        password: input.password,
        ...(input.method ? { method: input.method } : {}),
        ...(input.code ? { code: input.code } : {}),
        requestId: request.id ?? null,
      }),
    )
  }

  @Get('auth/sessions')
  @ApiBearerAuth()
  @Header('Cache-Control', 'no-store')
  async sessions(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    return {
      data: await this.runtime.sessions.list(claims.tenantId, claims.subject, claims.sid ?? null),
    }
  }

  @Delete('auth/sessions/:sessionId')
  @ApiBearerAuth()
  async endSession(@Param('sessionId') sessionId: string, @Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    return unwrap(
      await this.runtime.sessions.end(
        claims.tenantId,
        claims.subject,
        z.uuid().parse(sessionId),
        actor(request),
        request.id ?? null,
      ),
    )
  }

  @Post('auth/sessions/revoke-others')
  @ApiBearerAuth()
  @SkipIdempotency()
  @HttpCode(200)
  async endOthers(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    return this.runtime.sessions.endAll(
      claims.tenantId,
      claims.subject,
      claims.sid ?? null,
      actor(request),
      request.id ?? null,
    )
  }

  @Get('users/:userId/sessions')
  @RequirePermission('read', 'Users')
  @Header('Cache-Control', 'no-store')
  async userSessions(@Param('userId') userId: string, @Req() request: IdentityHttpRequest) {
    return {
      data: await this.runtime.sessions.list(
        principal(request).tenantId,
        z.uuid().parse(userId),
        null,
      ),
    }
  }

  @Delete('users/:userId/sessions')
  @RequirePermission('manage', 'Users')
  @RequireRecentAuth()
  async endUserSessions(@Param('userId') userId: string, @Req() request: IdentityHttpRequest) {
    return this.runtime.sessions.endAll(
      principal(request).tenantId,
      z.uuid().parse(userId),
      null,
      actor(request),
      request.id ?? null,
    )
  }

  // --- the signed-in person's second factors ----------------------------------------------

  private async accountOf(request: IdentityHttpRequest): Promise<string> {
    const claims = principal(request)
    const accountId = await this.runtime.database.accounts.findAccountIdByMembership(
      claims.tenantId,
      claims.subject,
    )
    if (!accountId) throw new ConflictException('sign out and in again to link your account')
    return accountId
  }

  @Get('me/mfa')
  @Header('Cache-Control', 'no-store')
  async factors(@Req() request: IdentityHttpRequest) {
    return this.runtime.secondFactors.list(await this.accountOf(request))
  }

  @Post('me/mfa/totp')
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async startTotp(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    const self = unwrap(
      await this.runtime.exportDataSubject.execute({
        tenantId: claims.tenantId,
        subjectId: claims.subject,
      }),
    )
    return this.runtime.secondFactors.startTotp(
      await this.accountOf(request),
      self.user.toSnapshot().email,
    )
  }

  @Post('me/mfa/totp/:factorId/confirm')
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async confirmTotp(
    @Param('factorId') factorId: string,
    @Body() body: unknown,
    @Req() request: IdentityHttpRequest,
  ) {
    const id = z.uuid().parse(factorId)
    const confirmed = unwrap(
      await this.runtime.secondFactors.confirmTotp(
        await this.accountOf(request),
        id,
        confirmTotp.parse(body).code,
      ),
    )
    await this.runtime.audit(context(request), 'mfa.enrolled', 'factor', id, { kind: 'totp' })
    return confirmed
  }

  @Post('me/mfa/passkeys/options')
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async passkeyOptions(@Req() request: IdentityHttpRequest) {
    const claims = principal(request)
    const accountId = await this.accountOf(request)
    const self = unwrap(
      await this.runtime.exportDataSubject.execute({
        tenantId: claims.tenantId,
        subjectId: claims.subject,
      }),
    )
    const options = await this.runtime.secondFactors.passkeyRegistrationOptions(
      accountId,
      self.user.toSnapshot().email,
    )
    await this.runtime.challenges.rememberWebauthn(accountId, options.challenge)
    return options.options
  }

  @Post('me/mfa/passkeys')
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async registerPasskey(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    const input = passkeyRegistration.parse(body)
    const accountId = await this.accountOf(request)
    const challenge = await this.runtime.challenges.takeWebauthn(accountId)
    if (!challenge) throw new ConflictException('start the passkey registration again')
    const registered = unwrap(
      await this.runtime.secondFactors.registerPasskey(
        accountId,
        input.response,
        challenge,
        input.label,
      ),
    )
    await this.runtime.audit(context(request), 'mfa.enrolled', 'factor', registered.factorId, {
      kind: 'passkey',
    })
    return registered
  }

  @Delete('me/mfa/factors/:factorId')
  @RequireRecentAuth()
  async removeFactor(@Param('factorId') factorId: string, @Req() request: IdentityHttpRequest) {
    const id = z.uuid().parse(factorId)
    unwrap(await this.runtime.secondFactors.remove(await this.accountOf(request), id))
    await this.runtime.audit(context(request), 'mfa.removed', 'factor', id, {})
    return { removed: true }
  }

  @Post('me/mfa/recovery-codes')
  @RequireRecentAuth()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async recoveryCodes(@Req() request: IdentityHttpRequest) {
    const codes = unwrap(
      await this.runtime.secondFactors.regenerateRecoveryCodes(await this.accountOf(request)),
    )
    await this.runtime.audit(
      context(request),
      'mfa.recovery-codes-regenerated',
      'account',
      principal(request).subject,
      {},
    )
    return { recoveryCodes: codes }
  }

  // --- invitations ---------------------------------------------------------------------------

  @Post('invitations')
  @RequirePermission('manage', 'Users')
  @RequireRecentAuth()
  @HttpCode(201)
  async invite(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    return unwrap(await this.runtime.invitations.invite(context(request), invite.parse(body)))
  }

  @Get('invitations')
  @RequirePermission('read', 'Users')
  @Header('Cache-Control', 'no-store')
  async invitations(@Req() request: IdentityHttpRequest) {
    return { data: await this.runtime.invitations.list(principal(request).tenantId) }
  }

  @Post('invitations/:invitationId/revoke')
  @RequirePermission('manage', 'Users')
  @HttpCode(200)
  async revokeInvitation(@Param('invitationId') id: string, @Req() request: IdentityHttpRequest) {
    return unwrap(await this.runtime.invitations.revoke(context(request), z.uuid().parse(id)))
  }

  @Post('invitations/:invitationId/resend')
  @RequirePermission('manage', 'Users')
  @HttpCode(200)
  async resendInvitation(@Param('invitationId') id: string, @Req() request: IdentityHttpRequest) {
    return unwrap(await this.runtime.invitations.resend(context(request), z.uuid().parse(id)))
  }

  @Get('invitations/lookup')
  @PublicRoute()
  @Header('Cache-Control', 'no-store')
  async lookup(@Query('token') value: unknown) {
    return unwrap(await this.runtime.invitations.lookup(invitationToken.parse(value)))
  }

  @Post('invitations/accept')
  @PublicRoute()
  @SkipIdempotency()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async accept(@Body() body: unknown) {
    return unwrap(await this.runtime.invitations.accept(accept.parse(body)))
  }

  // --- the workspace MFA policy ----------------------------------------------------------------

  @Get('workspace/mfa-policy')
  @Header('Cache-Control', 'no-store')
  async policy(@Req() request: IdentityHttpRequest) {
    return this.runtime.mfaPolicy.find(principal(request).tenantId)
  }

  @Put('workspace/mfa-policy')
  @RequirePermission('manage', 'Workspace')
  @RequireRecentAuth()
  async changePolicy(@Body() body: unknown, @Req() request: IdentityHttpRequest) {
    return unwrap(await this.runtime.mfaPolicy.change(context(request), policyInput.parse(body)))
  }
}
