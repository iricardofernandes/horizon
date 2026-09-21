import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import Redis from 'ioredis'
import { CreateCatalogItemUseCase } from '@/application/use-cases/create-catalog-item'
import { CreateUnitUseCase } from '@/application/use-cases/create-unit'
import { DeactivateCatalogItemUseCase } from '@/application/use-cases/deactivate-catalog-item'
import { DefineCompositionUseCase } from '@/application/use-cases/define-composition'
import {
  ListCatalogItemsUseCase,
  ListPriceListsUseCase,
  ListProductFamiliesUseCase,
  ListUnitsUseCase,
} from '@/application/use-cases/list-catalog'
import {
  AssignVariantUseCase,
  DefineProductFamilyUseCase,
} from '@/application/use-cases/manage-families'
import { CreatePriceListUseCase, SetPriceUseCase } from '@/application/use-cases/manage-prices'
import { ProvisionTenantCatalogUseCase } from '@/application/use-cases/provision-tenant-catalog'
import { RedisTokenDenylist } from '@/infrastructure/cache/redis-token-denylist'
import { JwksAccessTokenVerifier } from '@/infrastructure/cryptography/jwks-access-token-verifier'
import { SystemClock } from '@/infrastructure/cryptography/system-clock'
import { CatalogDatabase } from '@/infrastructure/database/drizzle/catalog-database'
import type { CatalogEnvironment } from './environment'

/** Explicit composition avoids erased interface metadata in the application layer. */
export class CatalogRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: CatalogDatabase
  readonly redis: Redis
  readonly accessTokens: JwksAccessTokenVerifier
  readonly denylist: RedisTokenDenylist
  readonly createUnit: CreateUnitUseCase
  readonly listUnits: ListUnitsUseCase
  readonly createItem: CreateCatalogItemUseCase
  readonly listItems: ListCatalogItemsUseCase
  readonly deactivateItem: DeactivateCatalogItemUseCase
  readonly listFamilies: ListProductFamiliesUseCase
  readonly defineFamily: DefineProductFamilyUseCase
  readonly assignVariant: AssignVariantUseCase
  readonly defineComposition: DefineCompositionUseCase
  readonly createPriceList: CreatePriceListUseCase
  readonly listPriceLists: ListPriceListsUseCase
  readonly setPrice: SetPriceUseCase
  readonly provisionTenantCatalog: ProvisionTenantCatalogUseCase

  constructor(readonly config: CatalogEnvironment) {
    const clock = new SystemClock()
    this.database = new CatalogDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    // Bounded everywhere and never queueing offline: a Redis stall must surface as the
    // denylist verdict the guard reasons about, not as a request that hangs (ADR 0027).
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 5000,
      commandTimeout: 5000,
    })
    this.redis.on('error', () =>
      new Logger(CatalogRuntime.name).warn('Redis connection unavailable'),
    )
    this.accessTokens = new JwksAccessTokenVerifier({
      jwksUrl: config.JWKS_URL,
      maxTokenAgeSeconds: config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    })
    this.denylist = new RedisTokenDenylist(this.redis)
    const db = this.database
    this.createUnit = new CreateUnitUseCase(db, clock)
    this.listUnits = new ListUnitsUseCase(db)
    this.createItem = new CreateCatalogItemUseCase(db, clock)
    this.listItems = new ListCatalogItemsUseCase(db)
    this.deactivateItem = new DeactivateCatalogItemUseCase(db, clock)
    this.listFamilies = new ListProductFamiliesUseCase(db)
    this.defineFamily = new DefineProductFamilyUseCase(db, clock)
    this.assignVariant = new AssignVariantUseCase(db, clock)
    this.defineComposition = new DefineCompositionUseCase(db, clock)
    this.createPriceList = new CreatePriceListUseCase(db, clock)
    this.listPriceLists = new ListPriceListsUseCase(db)
    this.setPrice = new SetPriceUseCase(db, clock)
    this.provisionTenantCatalog = new ProvisionTenantCatalogUseCase(db, clock, {
      priceListCurrency: config.DEFAULT_PRICE_LIST_CURRENCY,
    })
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.redis.connect(), this.database.ping()])
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect()
    await this.database.close()
  }
}
