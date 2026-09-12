import './load-environment'
import '@/infrastructure/observability/telemetry'
import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Logger } from 'nestjs-pino'
import { stopTelemetry } from '@/infrastructure/observability/telemetry'
import { AppModule } from './app.module'
import { readEnvironment } from './environment'

async function bootstrap(): Promise<void> {
  const config = readEnvironment()
  const runtimeModule = AppModule.register(config)
  runtimeModule.providers = [
    ...(runtimeModule.providers ?? []),
    {
      provide: 'TELEMETRY_SHUTDOWN',
      useValue: { onApplicationShutdown: stopTelemetry },
    },
  ]
  const app = await NestFactory.create(runtimeModule, { bufferLogs: true })
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Horizon Catalog')
      .setDescription(
        'Tenant-scoped product, unit and price-list API. Bearer tokens are verified locally against Identity’s published keys; the tenant comes from the token, never from a header.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  )
  SwaggerModule.setup('docs', app, document)
  try {
    await app.listen(config.PORT)
  } catch (error) {
    await app.close()
    await stopTelemetry()
    throw error
  }
}

void bootstrap().catch(async () => {
  process.stderr.write(
    'Catalog failed to start; verify configuration and infrastructure availability\n',
  )
  await stopTelemetry()
  process.exitCode = 1
})
