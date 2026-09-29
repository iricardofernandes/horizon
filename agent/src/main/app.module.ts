import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { AssistantController } from '@/infrastructure/http/assistant.controller'
import { AuditController } from '@/infrastructure/http/audit.controller'
import { AgentAuthGuard } from '@/infrastructure/http/authorization'
import { DraftsController } from '@/infrastructure/http/drafts.controller'
import { McpController } from '@/infrastructure/http/mcp.controller'
import { SettingsController } from '@/infrastructure/http/settings.controller'
import { erasureHandlers } from '@/infrastructure/messaging/erasure-handlers'
import { RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-consumer'
import { PurgeWorker } from '@/infrastructure/worker/purge-worker'
import { type AgentAdapters, AgentRuntime } from './agent-runtime'
import type { AgentEnvironment } from './environment'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(
    config: AgentEnvironment,
    adapters: AgentAdapters = {},
    options: { readonly background?: boolean } = {},
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: AgentRuntime, useFactory: () => new AgentRuntime(config, adapters) },
      {
        provide: APP_GUARD,
        inject: [AgentRuntime, Reflector],
        useFactory: (runtime: AgentRuntime, reflector: Reflector) =>
          new AgentAuthGuard(runtime.accessTokens, reflector),
      },
    ]
    if (options.background !== false) {
      // Conversations past their 30 days go, across tenants (Phase 76).
      providers.push({
        provide: PurgeWorker,
        inject: [AgentRuntime],
        useFactory: (runtime: AgentRuntime) =>
          new PurgeWorker(runtime.assistantDatabase, config.ASSISTANT_PURGE_INTERVAL_MS),
      })
      const rabbitUrl = config.RABBITMQ_URL
      if (rabbitUrl)
        // A person's erasure destroys their conversation key (ADR 0068).
        providers.push({
          provide: RabbitMqEventConsumer,
          inject: [AgentRuntime],
          useFactory: (runtime: AgentRuntime) =>
            new RabbitMqEventConsumer({
              url: rabbitUrl,
              queue: 'agent.erasure',
              handlers: erasureHandlers(runtime.assistantDatabase),
            }),
        })
    }
    return {
      module: AppModule,
      controllers: [
        McpController,
        SettingsController,
        AuditController,
        DraftsController,
        AssistantController,
      ],
      providers,
      exports: [AgentRuntime],
    }
  }
}
