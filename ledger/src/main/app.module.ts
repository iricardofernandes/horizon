import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { LedgerAuthGuard } from '@/infrastructure/http/authorization'
import { AuditController, DelegationsController } from '@/infrastructure/http/controls.controller'
import { LedgerController } from '@/infrastructure/http/ledger.controller'
import { JournalSealWorker } from '@/infrastructure/messaging/journal-replay'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
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
      {
        provide: RabbitMqEventConsumer,
        inject: [LedgerRuntime],
        useFactory: (runtime: LedgerRuntime) =>
          new RabbitMqEventConsumer({
            url: config.RABBITMQ_URL,
            queue: 'ledger.events',
            handlers: {
              ...runtime.eventHandlers.handlers,
              // Every workspace is known from its creation (Phase 79), so the journal seal
              // covers it even before it acts in this module.
              'identity.tenant.created': async (event) => {
                await runtime.database.inTenant(event.tenantId, async () => undefined)
              },
            },
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
      controllers: [LedgerController, DelegationsController, AuditController],
      providers,
      exports: [LedgerRuntime],
    }
  }
}
