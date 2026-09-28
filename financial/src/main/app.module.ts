import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { FinancialAuthGuard } from '@/infrastructure/http/authorization'
import { AuditController, DelegationsController } from '@/infrastructure/http/controls.controller'
import { DimensionsController } from '@/infrastructure/http/dimensions.controller'
import { ImportsController } from '@/infrastructure/http/imports.controller'
import { PayablesController, ReceivablesController } from '@/infrastructure/http/titles.controller'
import { ImportWorker, RelayImportScan } from '@/infrastructure/imports/import-worker'
import { JournalSealWorker } from '@/infrastructure/messaging/journal-replay'
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
    if (config.DATABASE_RELAY_URL) {
      const relayUrl = config.DATABASE_RELAY_URL
      providers.push({
        provide: ImportWorker,
        inject: [FinancialRuntime],
        useFactory: (runtime: FinancialRuntime) =>
          new ImportWorker({
            scan: new RelayImportScan(relayUrl),
            jobs: runtime.imports,
            intervalMs: config.IMPORT_POLL_INTERVAL_MS,
            retentionMs: config.IMPORT_RETENTION_HOURS * 3_600_000,
          }),
      })
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
      controllers: [
        DimensionsController,
        ReceivablesController,
        PayablesController,
        ImportsController,
        DelegationsController,
        AuditController,
      ],
      providers,
      exports: [FinancialRuntime],
    }
  }
}
