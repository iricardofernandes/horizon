import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'

import { AppModule } from '@/main/app.module'

/**
 * Phase 1 bootstrap. The application has no controllers and no providers yet —
 * this exists so that `typecheck`, `build`, `dev` and `start` are real commands
 * with real output rather than configuration nobody has run.
 *
 * Configuration validation, OpenTelemetry, the global exception filter, the
 * tenant interceptor and graceful shutdown all attach here in phase 4.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.enableShutdownHooks()

  const port = Number(process.env.PORT ?? 3004)
  await app.listen(port)
}

void bootstrap()
