import 'dotenv/config'
import '@/infrastructure/observability/telemetry'
import 'reflect-metadata'

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
    { provide: 'TELEMETRY_SHUTDOWN', useValue: { onApplicationShutdown: stopTelemetry } },
  ]
  const app = await NestFactory.create<NestExpressApplication>(runtimeModule)
  // A JSON-RPC message is small; a larger body is refused unread.
  app.useBodyParser('json', { limit: '256kb' })
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
  process.stderr.write('Agent failed to start; verify configuration and infrastructure\n')
  await stopTelemetry()
  process.exitCode = 1
})
