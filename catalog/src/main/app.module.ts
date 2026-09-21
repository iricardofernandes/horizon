import { randomUUID } from 'node:crypto'
import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core'
import { LoggerModule } from 'nestjs-pino'
import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { CatalogAuthGuard } from '@/infrastructure/http/authorization'
import { CompositionsController } from '@/infrastructure/http/compositions.controller'
import { FamiliesController } from '@/infrastructure/http/families.controller'
import { IdempotencyInterceptor } from '@/infrastructure/http/idempotency-interceptor'
import { IdempotencyStore } from '@/infrastructure/http/idempotency-store'
import { ItemsController } from '@/infrastructure/http/items.controller'
import { PriceListsController } from '@/infrastructure/http/price-lists.controller'
import { ProblemDetailsFilter } from '@/infrastructure/http/problem-details-filter'
import { SystemController } from '@/infrastructure/http/system.controller'
import { UnitsController } from '@/infrastructure/http/units.controller'
import { RabbitMqEventConsumer } from '@/infrastructure/messaging/event-consumer'
import { OutboxWorker } from '@/infrastructure/messaging/outbox-worker'
import { CatalogRuntime } from './catalog-runtime'
import type { CatalogEnvironment } from './environment'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a static registration factory.
export class AppModule {
  static register(config: CatalogEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: CatalogRuntime, useFactory: () => new CatalogRuntime(config) },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      {
        provide: APP_GUARD,
        inject: [CatalogRuntime, Reflector],
        useFactory: (runtime: CatalogRuntime, reflector: Reflector) =>
          new CatalogAuthGuard(runtime, reflector),
      },
      {
        provide: APP_INTERCEPTOR,
        inject: [CatalogRuntime, Reflector],
        useFactory: (runtime: CatalogRuntime, reflector: Reflector) =>
          new IdempotencyInterceptor(
            new IdempotencyStore(runtime.redis, new AesGcmSecretBox(), config.IDEMPOTENCY_SECRET, {
              ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS,
            }),
            reflector,
          ),
      },
    ]
    providers.push({
      provide: RabbitMqEventConsumer,
      inject: [CatalogRuntime],
      useFactory: (runtime: CatalogRuntime) =>
        new RabbitMqEventConsumer({
          url: config.RABBITMQ_URL,
          prefetch: config.AMQP_PREFETCH,
          handlers: {
            'identity.tenant.created': async (event) => {
              const provisioned = await runtime.provisionTenantCatalog.execute({
                tenantId: event.tenantId,
                event: {
                  sourceModule: 'identity',
                  eventId: event.eventId,
                  eventType: event.eventType,
                },
              })
              // A throw is the signal the consumer reads; it decides retry or dead-letter.
              if (provisioned.isLeft()) throw provisioned.value
            },
          },
        }),
    })
    // The relay is a separate role and therefore a separate connection string. Without
    // one, this process serves HTTP and something else delivers the outbox.
    if (config.DATABASE_RELAY_URL !== undefined)
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
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'req.headers["idempotency-key"]',
              'req.body',
              'res.body',
            ],
            genReqId: (request, response) => {
              const supplied = request.headers['x-request-id']
              const id =
                typeof supplied === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(supplied)
                  ? supplied
                  : randomUUID()
              response.setHeader('x-request-id', id)
              return id
            },
          },
        }),
      ],
      controllers: [
        UnitsController,
        ItemsController,
        FamiliesController,
        CompositionsController,
        PriceListsController,
        SystemController,
      ],
      providers,
      exports: [CatalogRuntime],
    }
  }
}
