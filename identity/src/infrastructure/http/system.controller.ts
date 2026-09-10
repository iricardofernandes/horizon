import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'

import { IdentityRuntime } from '@/main/identity-runtime'
import { PublicRoute } from './authorization'

@Controller()
@ApiTags('system')
export class SystemController {
  constructor(@Inject(IdentityRuntime) private readonly runtime: IdentityRuntime) {}

  @Get('.well-known/jwks.json')
  @PublicRoute()
  @Header('Cache-Control', 'public, max-age=60')
  jwks() {
    return { keys: this.runtime.signer.jwks() }
  }

  @Get('health/live')
  @PublicRoute()
  live() {
    return { status: 'ok' }
  }

  @Get('health/ready')
  @PublicRoute()
  async ready() {
    try {
      await Promise.all([this.runtime.database.ping(), this.runtime.redis.ping()])
      return { status: 'ok' }
    } catch {
      throw new ServiceUnavailableException()
    }
  }
}
