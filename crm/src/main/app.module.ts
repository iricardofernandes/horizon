import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { CrmAuthGuard } from '@/infrastructure/http/authorization'
import { CrmController } from '@/infrastructure/http/crm.controller'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import { CrmRuntime } from './crm-runtime'
import type { CrmEnvironment } from './environment'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: CrmEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: CrmRuntime, useFactory: () => new CrmRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [CrmRuntime, Reflector],
        useFactory: (runtime: CrmRuntime, reflector: Reflector) =>
          new CrmAuthGuard(runtime, reflector),
      },
      {
        provide: RabbitMqEventConsumer,
        inject: [CrmRuntime],
        useFactory: (runtime: CrmRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'crm.events',
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
    return {
      module: AppModule,
      controllers: [CrmController],
      providers,
      exports: [CrmRuntime],
    }
  }
}
