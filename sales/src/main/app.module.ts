import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { SalesAuthGuard } from '@/infrastructure/http/authorization'
import { BillingController } from '@/infrastructure/http/billing.controller'
import { ContractsController } from '@/infrastructure/http/contracts.controller'
import { SalesController } from '@/infrastructure/http/sales.controller'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import { BillingGauges } from '@/infrastructure/observability/billing-metrics'
import type { SalesEnvironment } from './environment'
import { SalesRuntime } from './sales-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: SalesEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: SalesRuntime, useFactory: () => new SalesRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [SalesRuntime, Reflector],
        useFactory: (runtime: SalesRuntime, reflector: Reflector) =>
          new SalesAuthGuard(runtime, reflector),
      },
      {
        provide: RabbitMqEventConsumer,
        inject: [SalesRuntime],
        useFactory: (runtime: SalesRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'sales.events',
            handlers: runtime.eventHandlers.handlers,
            prefetch: config.AMQP_PREFETCH,
          }),
      },
    ]
    if (config.DATABASE_RELAY_URL)
      providers.push(
        {
          provide: OutboxWorker,
          useFactory: () =>
            new OutboxWorker({
              databaseUrl: config.DATABASE_RELAY_URL ?? '',
              rabbitmqUrl: config.RABBITMQ_URL,
              intervalMs: config.OUTBOX_POLL_INTERVAL_MS,
              batchSize: config.OUTBOX_BATCH_SIZE,
            }),
        },
        {
          provide: BillingGauges,
          useFactory: () =>
            new BillingGauges({
              databaseUrl: config.DATABASE_RELAY_URL ?? '',
              thresholdSeconds: config.CONTRACT_BILLING_GAP_SECONDS,
            }),
        },
      )
    return {
      module: AppModule,
      controllers: [SalesController, ContractsController, BillingController],
      providers,
      exports: [SalesRuntime],
    }
  }
}
