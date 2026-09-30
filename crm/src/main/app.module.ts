import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { FireDueRemindersUseCase } from '@/application/use-cases/fire-due-reminders'
import { AuditController } from '@/infrastructure/http/audit.controller'
import { CrmAuthGuard } from '@/infrastructure/http/authorization'
import { CrmController } from '@/infrastructure/http/crm.controller'
import { MetricsController } from '@/infrastructure/http/metrics.controller'
import { OpportunitiesController } from '@/infrastructure/http/opportunities.controller'
import { RecordsController } from '@/infrastructure/http/records.controller'
import { JournalSealWorker } from '@/infrastructure/messaging/journal-replay'
import { OutboxWorker, RabbitMqEventConsumer } from '@/infrastructure/messaging/rabbitmq-transport'
import { RelayDueReminderTenants } from '@/infrastructure/scheduling/relay-due-reminder-tenants'
import { ReminderWorker } from '@/infrastructure/scheduling/reminder-worker'
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
    const relayUrl = config.DATABASE_RELAY_URL
    if (relayUrl)
      providers.push(
        {
          provide: OutboxWorker,
          useFactory: () =>
            new OutboxWorker({
              databaseUrl: relayUrl,
              rabbitmqUrl: config.RABBITMQ_URL,
              intervalMs: config.OUTBOX_POLL_INTERVAL_MS,
              batchSize: config.OUTBOX_BATCH_SIZE,
            }),
        },
        {
          // Reminders ask across tenants only which ones have work, as the relay role.
          provide: ReminderWorker,
          inject: [CrmRuntime],
          useFactory: (runtime: CrmRuntime) => {
            const tenants = new RelayDueReminderTenants(relayUrl)
            const reminders = new FireDueRemindersUseCase(
              runtime.database,
              tenants,
              runtime.clock,
              config.REMINDER_BATCH_SIZE,
            )
            return new ReminderWorker({
              run: () => reminders.execute(),
              intervalMs: config.REMINDER_POLL_INTERVAL_MS,
              close: () => tenants.close(),
            })
          },
        },
      )
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
      controllers: [
        CrmController,
        OpportunitiesController,
        RecordsController,
        MetricsController,
        AuditController,
      ],
      providers,
      exports: [CrmRuntime],
    }
  }
}
