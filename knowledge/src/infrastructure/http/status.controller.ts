import { Controller, Get, Inject, Req } from '@nestjs/common'
import { indexVersionOf } from '@/application/lexemes'
import { KnowledgeRuntime } from '@/main/knowledge-runtime'
import {
  type KnowledgeRequest,
  PublicRoute,
  principalOf,
  requireWorkspaceRole,
} from './authorization'

@Controller()
export class StatusController {
  constructor(@Inject(KnowledgeRuntime) private readonly runtime: KnowledgeRuntime) {}

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

  /** The workspace's documents by state, its chunks, and which embedder wrote them. */
  @Get('status')
  async status(@Req() request: KnowledgeRequest) {
    requireWorkspaceRole(request, ['owner', 'admin', 'auditor'])
    return {
      ...(await this.runtime.database.status(principalOf(request).tenantId)),
      indexVersion: indexVersionOf(this.runtime.embedder),
    }
  }
}
