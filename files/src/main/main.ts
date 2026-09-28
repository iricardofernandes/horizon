import 'dotenv/config'
import '@/infrastructure/observability/telemetry'
import 'reflect-metadata'

import { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES } from '@horizon/contracts'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { stopTelemetry } from '@/infrastructure/observability/telemetry'
import { AppModule } from '@/main/app.module'
import { readEnvironment } from '@/main/environment'

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
  const app = await NestFactory.create<NestExpressApplication>(runtimeModule)
  // An upload is the file itself, of an accepted type; anything larger is refused unread.
  app.useBodyParser('raw', {
    type: [...ATTACHMENT_CONTENT_TYPES],
    limit: ATTACHMENT_MAX_BYTES,
  })

  app.enableShutdownHooks()

  try {
    await app.listen(config.PORT)
  } catch (error) {
    await app.close()
    await stopTelemetry()
    throw error
  }
}

void bootstrap().catch(async () => {
  process.stderr.write('Files failed to start; verify configuration and infrastructure\n')
  await stopTelemetry()
  process.exitCode = 1
})
