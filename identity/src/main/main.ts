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
      .setTitle('Horizon Identity')
      .setDescription(
        'Tenant-scoped identity API. Bearer tokens are verified locally. Only explicitly documented nonprivileged reads may proceed during a revocation-store outage.',
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
    'Identity failed to start; verify configuration and infrastructure availability\n',
  )
  await stopTelemetry()
  process.exitCode = 1
})
