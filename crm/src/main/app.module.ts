import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { FireDueRemindersUseCase } from '@/application/use-cases/fire-due-reminders'
import { CrmAuthGuard } from '@/infrastructure/http/authorization'
import { CrmController } from '@/infrastructure/http/crm.controller'
import { MetricsController } from '@/infrastructure/http/metrics.controller'
import { OpportunitiesController } from '@/infrastructure/http/opportunities.controller'
import { RecordsController } from '@/infrastructure/http/records.controller'
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
            handlers: runtime.eventHandlers.handlers,
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
    return {
      module: AppModule,
      controllers: [CrmController, OpportunitiesController, RecordsController, MetricsController],
      providers,
      exports: [CrmRuntime],
    }
  }
}
