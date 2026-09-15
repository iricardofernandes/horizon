import { Controller, Get, Inject } from '@nestjs/common'
import { WebhookRuntime } from '@/main/webhook-runtime'
import { PublicRoute } from './authorization'

@Controller('health')
export class SystemController {
  constructor(@Inject(WebhookRuntime) private readonly runtime: WebhookRuntime) {}

  @Get('live')
  @PublicRoute()
  live() {
    return { status: 'ok' }
  }

  @Get('ready')
  @PublicRoute()
  async ready() {
    await this.runtime.database.queueDepth()
    return { status: 'ok' }
  }
}
