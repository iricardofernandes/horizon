import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core'
import { LoggerModule } from 'nestjs-pino'

import { AesGcmSecretBox } from '@/infrastructure/cryptography/aes-gcm-secret-box'
import { AdministrationController } from '@/infrastructure/http/administration.controller'
import { AuthController } from '@/infrastructure/http/auth.controller'
import { IdentityAuthGuard } from '@/infrastructure/http/authorization'
import { IdempotencyInterceptor } from '@/infrastructure/http/idempotency-interceptor'
import { IdempotencyStore } from '@/infrastructure/http/idempotency-store'
import { ProblemDetailsFilter } from '@/infrastructure/http/problem-details-filter'
import { SystemController } from '@/infrastructure/http/system.controller'
import { UsersController } from '@/infrastructure/http/users.controller'
import { OutboxWorker } from '@/infrastructure/messaging/outbox-worker'
import type { IdentityEnvironment } from './environment'
import { IdentityRuntime } from './identity-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a static registration factory.
export class AppModule {
  static register(config: IdentityEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: IdentityRuntime, useFactory: () => new IdentityRuntime(config) },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      {
        provide: APP_GUARD,
        inject: [IdentityRuntime, Reflector],
        useFactory: (runtime: IdentityRuntime, reflector: Reflector) =>
          new IdentityAuthGuard(runtime, reflector),
      },
      {
        provide: APP_INTERCEPTOR,
        inject: [IdentityRuntime, Reflector],
        useFactory: (runtime: IdentityRuntime, reflector: Reflector) => {
          const key = Buffer.from(readFileSync(config.BLIND_INDEX_KEY_PATH, 'utf8').trim(), 'hex')
          const secret = createHmac('sha256', key)
            .update('horizon:identity:idempotency:v1')
            .digest('hex')
          return new IdempotencyInterceptor(
            new IdempotencyStore(runtime.redis, new AesGcmSecretBox(), secret, {
              ttlSeconds: config.IDEMPOTENCY_TTL_SECONDS,
            }),
            reflector,
          )
        },
      },
    ]
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
              'res.headers["set-cookie"]',
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
      controllers: [AuthController, UsersController, AdministrationController, SystemController],
      providers,
      exports: [IdentityRuntime],
    }
  }
}
