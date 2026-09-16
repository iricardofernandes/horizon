import 'dotenv/config'
import '@/infrastructure/observability/telemetry'
import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'

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
  const app = await NestFactory.create(runtimeModule)

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
  process.stderr.write('Financial failed to start; verify configuration and infrastructure\n')
  await stopTelemetry()
  process.exitCode = 1
})
