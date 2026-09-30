import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { InventoryAuthGuard } from '@/infrastructure/http/authorization'
import { AuditController, DelegationsController } from '@/infrastructure/http/controls.controller'
import { ImportsController } from '@/infrastructure/http/imports.controller'
import { InventoryController } from '@/infrastructure/http/inventory.controller'
import { ImportWorker, RelayImportScan } from '@/infrastructure/imports/import-worker'
import { JournalSealWorker } from '@/infrastructure/messaging/journal-replay'
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
            handlers: {
              ...runtime.eventHandlers.handlers,
              // Every workspace is known from its creation (Phase 79), so the journal seal
              // covers it even before it acts in this module.
              'identity.tenant.created': async (event) => {
                await runtime.database.provisionTenant(event.tenantId)
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
        provide: ImportWorker,
        inject: [InventoryRuntime],
        useFactory: (runtime: InventoryRuntime) =>
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
      controllers: [InventoryController, ImportsController, DelegationsController, AuditController],
      providers,
      exports: [InventoryRuntime],
    }
  }
}
