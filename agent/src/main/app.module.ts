import { type DynamicModule, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { AuditController } from '@/infrastructure/http/audit.controller'
import { AgentAuthGuard } from '@/infrastructure/http/authorization'
import { DraftsController } from '@/infrastructure/http/drafts.controller'
import { McpController } from '@/infrastructure/http/mcp.controller'
import { SettingsController } from '@/infrastructure/http/settings.controller'
import { type AgentAdapters, AgentRuntime } from './agent-runtime'
import type { AgentEnvironment } from './environment'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: AgentEnvironment, adapters: AgentAdapters = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [McpController, SettingsController, AuditController, DraftsController],
      providers: [
        { provide: AgentRuntime, useFactory: () => new AgentRuntime(config, adapters) },
        {
          provide: APP_GUARD,
          inject: [AgentRuntime, Reflector],
          useFactory: (runtime: AgentRuntime, reflector: Reflector) =>
            new AgentAuthGuard(runtime.accessTokens, reflector),
        },
      ],
      exports: [AgentRuntime],
    }
  }
}
