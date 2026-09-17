import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { TreasuryAuthGuard } from '@/infrastructure/http/authorization'
import { ReconciliationController } from '@/infrastructure/http/reconciliation.controller'
import { TreasuryController } from '@/infrastructure/http/treasury.controller'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import type { TreasuryEnvironment } from './environment'
import { TreasuryRuntime } from './treasury-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: TreasuryEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: TreasuryRuntime, useFactory: () => new TreasuryRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [TreasuryRuntime, Reflector],
        useFactory: (runtime: TreasuryRuntime, reflector: Reflector) =>
          new TreasuryAuthGuard(runtime, reflector),
      },
      {
        provide: RabbitMqEventConsumer,
        inject: [TreasuryRuntime],
        useFactory: (runtime: TreasuryRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'treasury.events',
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
      controllers: [TreasuryController, ReconciliationController],
      providers,
      exports: [TreasuryRuntime],
    }
  }
}
