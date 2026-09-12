import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { CatalogRuntime } from '@/main/catalog-runtime'
import { PublicRoute } from './authorization'

@Controller()
@ApiTags('system')
export class SystemController {
  constructor(@Inject(CatalogRuntime) private readonly runtime: CatalogRuntime) {}

  /** Liveness answers "is the process running", never "are its dependencies healthy" —
   * a dependency check here would have the orchestrator restart a healthy container
   * during someone else's outage. */
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
