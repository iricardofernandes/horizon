import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ProcurementAuthGuard } from '@/infrastructure/http/authorization'
import { ProcurementController } from '@/infrastructure/http/procurement.controller'
import { JournalSealWorker } from '@/infrastructure/messaging/journal-replay'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import type { ProcurementEnvironment } from './environment'
import { ProcurementRuntime } from './procurement-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: ProcurementEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: ProcurementRuntime, useFactory: () => new ProcurementRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [ProcurementRuntime, Reflector],
        useFactory: (runtime: ProcurementRuntime, reflector: Reflector) =>
          new ProcurementAuthGuard(runtime, reflector),
      },
      {
        provide: RabbitMqEventConsumer,
        inject: [ProcurementRuntime],
        useFactory: (runtime: ProcurementRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'procurement.events',
            handlers: runtime.eventHandlers.handlers,
            prefetch: config.AMQP_PREFETCH,
          }),
      },
    ]
    if (config.DATABASE_RELAY_URL)
      providers.push({
        provide: OutboxWorker,
        useFactory: () =>
          new OutboxWorker({
            databaseUrl: config.DATABASE_RELAY_URL ?? '',
            rabbitmqUrl: config.RABBITMQ_URL,
            intervalMs: config.OUTBOX_POLL_INTERVAL_MS,
            batchSize: config.OUTBOX_BATCH_SIZE,
          }),
      })
    if (config.DATABASE_RELAY_URL) {
      const relayUrl = config.DATABASE_RELAY_URL
      providers.push({
        // Seals every tenant's history for reporting, as the relay role (Phase 62).
        provide: JournalSealWorker,
        useFactory: () =>
          new JournalSealWorker({
            databaseUrl: relayUrl,
            rabbitmqUrl: config.RABBITMQ_URL,
            intervalMs: config.JOURNAL_SEAL_INTERVAL_MS,
          }),
      })
    }
    return {
      module: AppModule,
      controllers: [ProcurementController],
      providers,
      exports: [ProcurementRuntime],
    }
  }
}
