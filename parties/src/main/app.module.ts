import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { PartiesAuthGuard } from '@/infrastructure/http/authorization'
import { ImportsController } from '@/infrastructure/http/imports.controller'
import { PartiesController } from '@/infrastructure/http/parties.controller'
import { ImportWorker, RelayImportScan } from '@/infrastructure/imports/import-worker'
import { OutboxWorker } from '@/infrastructure/messaging/rabbitmq-transport'
import type { PartiesEnvironment } from './environment'
import { PartiesRuntime } from './parties-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: PartiesEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: PartiesRuntime, useFactory: () => new PartiesRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [PartiesRuntime, Reflector],
        useFactory: (runtime: PartiesRuntime, reflector: Reflector) =>
          new PartiesAuthGuard(runtime, reflector),
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
    if (config.DATABASE_RELAY_URL)
      providers.push({
        provide: ImportWorker,
        inject: [PartiesRuntime],
        useFactory: (runtime: PartiesRuntime) =>
          new ImportWorker({
            scan: new RelayImportScan(config.DATABASE_RELAY_URL ?? ''),
            jobs: runtime.imports,
            intervalMs: config.IMPORT_POLL_INTERVAL_MS,
            retentionMs: config.IMPORT_RETENTION_HOURS * 3_600_000,
          }),
      })
    return {
      module: AppModule,
      controllers: [PartiesController, ImportsController],
      providers,
      exports: [PartiesRuntime],
    }
  }
}
