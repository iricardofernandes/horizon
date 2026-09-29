import { BadRequestException, Body, Controller, Get, Inject, Put, Req } from '@nestjs/common'
import { z } from 'zod'
import { AgentRuntime } from '@/main/agent-runtime'
import { type AgentRequest, PublicRoute, principalOf, requireWorkspaceRole } from './authorization'

const settingsInput = z.strictObject({ enabled: z.boolean() })

@Controller()
export class SettingsController {
  constructor(@Inject(AgentRuntime) private readonly runtime: AgentRuntime) {}

  @Get('health/live')
  @PublicRoute()
  live() {
    return { status: 'ok' }
  }

  @Get('health/ready')
  @PublicRoute()
  async ready() {
    await this.runtime.database.ping()
    return { status: 'ok' }
  }

  /** Whether agents may connect to this workspace; off until an owner or admin says so. */
  @Get('settings')
  async settings(@Req() request: AgentRequest) {
    requireWorkspaceRole(request, ['owner', 'admin'])
    return this.runtime.database.settings(principalOf(request).tenantId)
  }

  @Put('settings')
  async update(@Body() body: unknown, @Req() request: AgentRequest) {
    requireWorkspaceRole(request, ['owner', 'admin'])
    const parsed = settingsInput.safeParse(body)
    if (!parsed.success) throw new BadRequestException('Send { "enabled": true | false }')
    const principal = principalOf(request)
    await this.runtime.database.setAccess(
      principal.tenantId,
      parsed.data.enabled,
      principal.subject,
      this.runtime.clock.now(),
    )
    return this.runtime.database.settings(principal.tenantId)
  }
}
