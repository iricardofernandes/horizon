import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { LedgerAuthGuard } from '@/infrastructure/http/authorization'
import { LedgerController } from '@/infrastructure/http/ledger.controller'
import { OutboxWorker } from '@/infrastructure/messaging/rabbitmq-transport'
import type { LedgerEnvironment } from './environment'
import { LedgerRuntime } from './ledger-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: LedgerEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: LedgerRuntime, useFactory: () => new LedgerRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [LedgerRuntime, Reflector],
        useFactory: (runtime: LedgerRuntime, reflector: Reflector) =>
          new LedgerAuthGuard(runtime, reflector),
      },
    ]
    // The ledger publishes what it posts; it consumes nothing yet, so it has no queue.
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
      controllers: [LedgerController],
      providers,
      exports: [LedgerRuntime],
    }
  }
}
