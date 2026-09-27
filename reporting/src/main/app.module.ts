import { REPORTING_REPLAY_QUEUE } from '@horizon/contracts'
import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JOURNALED_EVENT_TYPES } from '@/application/journal-intake'
import { ReportingAuthGuard } from '@/infrastructure/http/authorization'
import { ReportingController } from '@/infrastructure/http/reporting.controller'
import { ReportsController } from '@/infrastructure/http/reports.controller'
import { QueueConsumer } from '@/infrastructure/messaging/queue-consumer'
import type { ReportingEnvironment } from './environment'
import { ReportingRuntime } from './reporting-runtime'

const LIVE_CONSUMER = 'LIVE_CONSUMER'
const REPLAY_CONSUMER = 'REPLAY_CONSUMER'

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
            bindings: [],
            handle: async (body) => {
              const outcome = await runtime.intake.replay(body)
              return typeof outcome === 'string' ? outcome : `seal-${outcome.outcome}`
            },
            prefetch: 1,
          }),
      },
    ]
    return {
      module: AppModule,
      controllers: [ReportingController, ReportsController],
      providers,
      exports: [ReportingRuntime],
    }
  }
}
