import { REPORTING_REPLAY_QUEUE } from '@horizon/contracts'
import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JOURNALED_EVENT_TYPES } from '@/application/journal-intake'
import { NOTIFYING_EVENT_TYPES } from '@/application/notifications'
import { FreshnessGauge } from '@/infrastructure/controls/freshness-gauge'
import {
  RelayTenantScan,
  ScheduledControlsWorker,
} from '@/infrastructure/controls/scheduled-controls-worker'
import { ServiceTokens } from '@/infrastructure/controls/service-tokens'
import { ExportWorker, RelayExportWorkScan } from '@/infrastructure/exports/export-worker'
import { AuditController } from '@/infrastructure/http/audit.controller'
import { ReportingAuthGuard } from '@/infrastructure/http/authorization'
import { ConsistencyController } from '@/infrastructure/http/consistency.controller'
import { ExportsController } from '@/infrastructure/http/exports.controller'
import { ReportingController } from '@/infrastructure/http/reporting.controller'
import { ReportsController } from '@/infrastructure/http/reports.controller'
import { UserStateController } from '@/infrastructure/http/user-state.controller'
import { QueueConsumer } from '@/infrastructure/messaging/queue-consumer'
import type { ReportingEnvironment } from './environment'
import { ReportingRuntime } from './reporting-runtime'

const LIVE_CONSUMER = 'LIVE_CONSUMER'
const REPLAY_CONSUMER = 'REPLAY_CONSUMER'
const NOTIFICATION_CONSUMER = 'NOTIFICATION_CONSUMER'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: ReportingEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: ReportingRuntime, useFactory: () => new ReportingRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [ReportingRuntime, Reflector],
        useFactory: (runtime: ReportingRuntime, reflector: Reflector) =>
          new ReportingAuthGuard(runtime.accessTokens, reflector),
      },
      {
        // The live flow: every event of the journaled modules, bound on the topic exchange.
        provide: LIVE_CONSUMER,
        inject: [ReportingRuntime],
        useFactory: (runtime: ReportingRuntime) =>
          new QueueConsumer({
            url: config.RABBITMQ_URL,
            queue: 'reporting.events',
            bindings: JOURNALED_EVENT_TYPES,
            handle: (body) => runtime.intake.live(body),
            prefetch: config.AMQP_PREFETCH,
          }),
      },
      {
        // A producer's resend, then its seal: one at a time, so the seal is read last.
        provide: REPLAY_CONSUMER,
        inject: [ReportingRuntime],
        useFactory: (runtime: ReportingRuntime) =>
          new QueueConsumer({
            url: config.RABBITMQ_URL,
            queue: REPORTING_REPLAY_QUEUE,
            // Producers resend and seal through their own exchange (Phase 90), each under
            // routing keys of its own, so the broker refuses one module sealing another's.
            exchange: 'horizon.journal',
            bindings: ['#'],
            handle: async (body) => {
              const outcome = await runtime.intake.replay(body)
              return typeof outcome === 'string' ? outcome : `seal-${outcome.outcome}`
            },
            prefetch: 1,
          }),
      },
      {
        // What needs a person's attention, once per event and recipient (Phase 66). Live only:
        // a replay of history goes to the journal and never notifies.
        provide: NOTIFICATION_CONSUMER,
        inject: [ReportingRuntime],
        useFactory: (runtime: ReportingRuntime) =>
          new QueueConsumer({
            url: config.RABBITMQ_URL,
            queue: 'reporting.notifications',
            bindings: NOTIFYING_EVENT_TYPES,
            handle: (body) => runtime.notificationIntake.handle(body),
            prefetch: config.AMQP_PREFETCH,
          }),
      },
    ]
    const relayUrl = config.DATABASE_RELAY_URL
    if (relayUrl)
      providers.push({
        // Exports are written, scheduled and expired by a worker that finds its tenants as
        // the relay role (Phase 63).
        provide: ExportWorker,
        inject: [ReportingRuntime],
        useFactory: (runtime: ReportingRuntime) =>
          new ExportWorker({
            scan: new RelayExportWorkScan(relayUrl),
            work: runtime.exportWork,
            intervalMs: config.EXPORT_POLL_INTERVAL_MS,
            leaseMs: config.EXPORT_LEASE_MS,
          }),
      })
    if (relayUrl)
      providers.push({
        // Report freshness for its service level (Phase 70), read as the relay role.
        provide: FreshnessGauge,
        useFactory: () => new FreshnessGauge({ databaseUrl: relayUrl }),
      })
    const secret = config.SERVICE_TOKEN_SECRET
    if (relayUrl && secret)
      providers.push({
        // Consistency checks and reconciliations on a schedule, with the service identity
        // (Phase 69), for every tenant found as the relay role.
        provide: ScheduledControlsWorker,
        inject: [ReportingRuntime],
        useFactory: (runtime: ReportingRuntime) =>
          new ScheduledControlsWorker({
            scan: new RelayTenantScan(relayUrl),
            tokens: new ServiceTokens(config.GATEWAY_URL, secret),
            consistency: runtime.consistency,
            reconciliation: runtime.runReconciliation,
            reads: runtime.database.reports,
            intervalMs: config.CONTROLS_INTERVAL_SECONDS * 1000,
            firstDelayMs: config.CONTROLS_FIRST_DELAY_SECONDS * 1000,
          }),
      })
    return {
      module: AppModule,
      controllers: [
        ReportingController,
        ReportsController,
        ExportsController,
        UserStateController,
        AuditController,
        ConsistencyController,
      ],
      providers,
      exports: [ReportingRuntime],
    }
  }
}
