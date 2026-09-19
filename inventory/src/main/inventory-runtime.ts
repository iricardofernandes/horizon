import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { InventoryProcurementEventHandlers } from '@/application/consume-procurement-events'
import { InventorySalesEventHandlers } from '@/application/consume-sales-events'
import {
  CreateWarehouseUseCase,
  DeactivateWarehouseUseCase,
  ReceiveStockUseCase,
} from '@/application/use-cases/manage-inventory'
import { AccessTokenVerifier } from '@/infrastructure/cryptography/access-token-verifier'
import { InventoryDatabase } from '@/infrastructure/database/drizzle/inventory-database'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { InventoryEnvironment } from './environment'

export class InventoryRuntime implements OnModuleInit, OnModuleDestroy {
  readonly database: InventoryDatabase
  /** One map per source module, merged into the queue's handlers at registration. */
  readonly eventHandlers: { readonly handlers: Readonly<Record<string, EventHandler>> }
  readonly salesEvents: InventorySalesEventHandlers
  readonly procurementEvents: InventoryProcurementEventHandlers
  readonly accessTokens: AccessTokenVerifier
  readonly createWarehouse: CreateWarehouseUseCase
  readonly deactivateWarehouse: DeactivateWarehouseUseCase
  readonly receiveStock: ReceiveStockUseCase

  constructor(config: InventoryEnvironment) {
    this.database = new InventoryDatabase({
      url: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
      statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    })
    const clock = { now: () => new Date() }
    this.createWarehouse = new CreateWarehouseUseCase(this.database, clock)
    this.deactivateWarehouse = new DeactivateWarehouseUseCase(this.database, clock)
    this.receiveStock = new ReceiveStockUseCase(this.database, clock)
    this.accessTokens = new AccessTokenVerifier(
      config.JWKS_URL,
      config.ACCESS_TOKEN_MAX_AGE_SECONDS,
    )
    this.salesEvents = new InventorySalesEventHandlers(
      this.database,
      clock,
      config.RESERVATION_TTL_SECONDS,
    )
    this.procurementEvents = new InventoryProcurementEventHandlers(this.database, clock)
    this.eventHandlers = {
      handlers: { ...this.salesEvents.handlers, ...this.procurementEvents.handlers },
    }
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
