import { type DynamicModule, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { FinancialAuthGuard } from '@/infrastructure/http/authorization'
import { DimensionsController } from '@/infrastructure/http/dimensions.controller'
import type { FinancialEnvironment } from './environment'
import { FinancialRuntime } from './financial-runtime'

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules expose a registration factory.
export class AppModule {
  static register(config: FinancialEnvironment): DynamicModule {
    const providers: Provider[] = [
      { provide: FinancialRuntime, useFactory: () => new FinancialRuntime(config) },
      {
        provide: APP_GUARD,
        inject: [FinancialRuntime, Reflector],
        useFactory: (runtime: FinancialRuntime, reflector: Reflector) =>
          new FinancialAuthGuard(runtime, reflector),
      },
    ]
    return {
      module: AppModule,
      controllers: [DimensionsController],
      providers,
      exports: [FinancialRuntime],
    }
  }
}
