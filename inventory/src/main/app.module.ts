import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { InventoryAuthGuard } from '@/infrastructure/http/authorization'
import { InventoryController } from '@/infrastructure/http/inventory.controller'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import type { InventoryEnvironment } from './environment'
import { InventoryRuntime } from './inventory-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: InventoryEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: InventoryRuntime, useFactory: () => new InventoryRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [InventoryRuntime, Reflector],
        useFactory: (runtime: InventoryRuntime, reflector: Reflector) =>
          new InventoryAuthGuard(runtime, reflector),
      },
      {
        provide: RabbitMqEventConsumer,
        inject: [InventoryRuntime],
        useFactory: (runtime: InventoryRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'inventory.events',
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
      controllers: [InventoryController],
      providers,
      exports: [InventoryRuntime],
    }
  }
}
