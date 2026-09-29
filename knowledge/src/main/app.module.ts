import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { indexVersionOf } from '@/application/lexemes'
import { RelayDueScan } from '@/infrastructure/database/knowledge-database'
import { KnowledgeAuthGuard } from '@/infrastructure/http/authorization'
import { SearchController } from '@/infrastructure/http/search.controller'
import { StatusController } from '@/infrastructure/http/status.controller'
import { SuggestionsController } from '@/infrastructure/http/suggestions.controller'
import { exampleHandlers } from '@/infrastructure/messaging/example-handlers'
import { indexHandlers } from '@/infrastructure/messaging/handlers'
import { RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-consumer'
import { IndexWorker } from '@/infrastructure/worker/index-worker'
import { NcmTableWorker } from '@/infrastructure/worker/ncm-table-worker'
import type { KnowledgeEnvironment } from './environment'
import { type KnowledgeAdapters, KnowledgeRuntime, suggestionsOn } from './knowledge-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(
    config: KnowledgeEnvironment,
    adapters: KnowledgeAdapters = {},
    options: { readonly consume?: boolean } = {},
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: KnowledgeRuntime, useFactory: () => new KnowledgeRuntime(config, adapters) },
      {
        provide: APP_GUARD,
        inject: [KnowledgeRuntime, Reflector],
        useFactory: (runtime: KnowledgeRuntime, reflector: Reflector) =>
          new KnowledgeAuthGuard(runtime.accessTokens, reflector),
      },
    ]
    if (options.consume !== false)
      providers.push({
        // Available files become due; ended ones leave the index with a tombstone.
        provide: RabbitMqEventConsumer,
        inject: [KnowledgeRuntime],
        useFactory: (runtime: KnowledgeRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'knowledge.documents',
            handlers: {
              ...indexHandlers(runtime.indexing),
              ...exampleHandlers(runtime.exampleIndex),
            },
            prefetch: config.AMQP_PREFETCH,
          }),
      })
    const relayUrl = config.DATABASE_RELAY_URL
    if (relayUrl && options.consume !== false)
      providers.push({
        provide: IndexWorker,
        inject: [KnowledgeRuntime],
        useFactory: (runtime: KnowledgeRuntime) =>
          new IndexWorker({
            scan: new RelayDueScan(relayUrl),
            indexing: runtime.indexing,
            indexVersion: indexVersionOf(runtime.embedder),
            intervalMs: config.KNOWLEDGE_POLL_INTERVAL_MS,
            lag: (seconds) => runtime.metrics.lag(seconds),
          }),
      })
    if (suggestionsOn(config) && options.consume !== false)
      providers.push({
        // The official NCM table, embedded once per act and embedder (Phase 77).
        provide: NcmTableWorker,
        inject: [KnowledgeRuntime],
        useFactory: (runtime: KnowledgeRuntime) =>
          new NcmTableWorker(runtime.ncmTable, config.KNOWLEDGE_NCM_TABLE),
      })
    return {
      module: AppModule,
      controllers: [StatusController, SearchController, SuggestionsController],
      providers,
      exports: [KnowledgeRuntime],
    }
  }
}
