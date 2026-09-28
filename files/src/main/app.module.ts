import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { RelayDueScan } from '@/infrastructure/database/drizzle/files-database'
import { FilesAuthGuard } from '@/infrastructure/http/authorization'
import { FilesController } from '@/infrastructure/http/files.controller'
import { erasureHandlers } from '@/infrastructure/messaging/erasure-handlers'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import { FilesWorker } from '@/infrastructure/worker/files-worker'
import type { FilesEnvironment } from './environment'
import { FilesRuntime } from './files-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: FilesEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: FilesRuntime, useFactory: () => new FilesRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [FilesRuntime, Reflector],
        useFactory: (runtime: FilesRuntime, reflector: Reflector) =>
          new FilesAuthGuard(runtime.accessTokens, reflector),
      },
      {
        // Owners erased elsewhere shred their files here (ADR 0026, ADR 0060).
        provide: RabbitMqEventConsumer,
        inject: [FilesRuntime],
        useFactory: (runtime: FilesRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'files.erasures',
            handlers: erasureHandlers(runtime.lifecycle),
            prefetch: config.AMQP_PREFETCH,
          }),
      },
    ]
    const relayUrl = config.DATABASE_RELAY_URL
    if (relayUrl)
      providers.push(
        {
          provide: OutboxWorker,
          useFactory: () =>
            new OutboxWorker({ databaseUrl: relayUrl, rabbitmqUrl: config.RABBITMQ_URL }),
        },
        {
          // Scans again, expires by retention and removes bytes, finding tenants as the relay.
          provide: FilesWorker,
          inject: [FilesRuntime],
          useFactory: (runtime: FilesRuntime) =>
            new FilesWorker({
              scan: new RelayDueScan(relayUrl),
              lifecycle: runtime.lifecycle,
              intervalMs: config.FILES_POLL_INTERVAL_MS,
            }),
        },
      )
    return {
      module: AppModule,
      controllers: [FilesController],
      providers,
      exports: [FilesRuntime],
    }
  }
}
