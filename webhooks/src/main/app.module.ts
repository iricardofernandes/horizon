import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { WebhookAuthGuard } from '@/infrastructure/http/authorization'
import { SystemController } from '@/infrastructure/http/system.controller'
import {
  WebhookDeliveriesController,
  WebhookSubscriptionsController,
} from '@/infrastructure/http/webhooks.controller'
import { DeliveryWorker } from '@/infrastructure/messaging/delivery-worker'
import { WebhookEventConsumer } from '@/infrastructure/messaging/event-consumer'
import type { WebhookEnvironment } from './environment'
import { WebhookRuntime } from './webhook-runtime'

/**
 * Deliberately empty. Feature modules are wired here as they arrive; see
 * docs/plan.md for which phase brings what.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: WebhookEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: WebhookRuntime, useFactory: () => new WebhookRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [WebhookRuntime, Reflector],
        useFactory: (runtime: WebhookRuntime, reflector: Reflector) =>
          new WebhookAuthGuard(runtime, reflector),
      },
      {
        provide: WebhookEventConsumer,
        inject: [WebhookRuntime],
        useFactory: (runtime: WebhookRuntime) =>
          new WebhookEventConsumer({
            url: config.RABBITMQ_URL,
            repository: runtime.database,
            prefetch: config.AMQP_PREFETCH,
          }),
      },
      {
        provide: DeliveryWorker,
        inject: [WebhookRuntime],
        useFactory: (runtime: WebhookRuntime) =>
          new DeliveryWorker(runtime.dispatcher, config.OUTBOX_POLL_INTERVAL_MS),
      },
    ]
    return {
      module: AppModule,
      controllers: [SystemController, WebhookSubscriptionsController, WebhookDeliveriesController],
      providers,
      exports: [WebhookRuntime],
    }
  }
}
