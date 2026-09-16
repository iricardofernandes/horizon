import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { FinancialAuthGuard } from '@/infrastructure/http/authorization'
import { DimensionsController } from '@/infrastructure/http/dimensions.controller'
import { ReceivablesController } from '@/infrastructure/http/receivables.controller'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import type { FinancialEnvironment } from './environment'
import { FinancialRuntime } from './financial-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: FinancialEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: FinancialRuntime, useFactory: () => new FinancialRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [FinancialRuntime, Reflector],
        useFactory: (runtime: FinancialRuntime, reflector: Reflector) =>
          new FinancialAuthGuard(runtime, reflector),
      },
      {
        provide: RabbitMqEventConsumer,
        inject: [FinancialRuntime],
        useFactory: (runtime: FinancialRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'financial.events',
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
      controllers: [DimensionsController, ReceivablesController],
      providers,
      exports: [FinancialRuntime],
    }
  }
}
