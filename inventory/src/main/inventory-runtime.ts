import { type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { InventoryCatalogEventHandlers } from '@/application/consume-catalog-events'
import { InventoryProcurementEventHandlers } from '@/application/consume-procurement-events'
import { InventorySalesEventHandlers } from '@/application/consume-sales-events'
import { AdjustStockUseCase, DecideAdjustmentUseCase } from '@/application/use-cases/adjust-stock'
import {
  CloseStockCountUseCase,
  DecideStockCountUseCase,
  OpenStockCountUseCase,
  RecordStockCountUseCase,
} from '@/application/use-cases/count-stock'
import {
  DefineAdjustmentPolicyUseCase,
  DefineItemTrackingUseCase,
  DefineStockLevelUseCase,
} from '@/application/use-cases/define-policies'
import {
  CreateWarehouseUseCase,
  DeactivateWarehouseUseCase,
  ReceiveStockUseCase,
} from '@/application/use-cases/manage-inventory'
import {
  CancelProductionOrderUseCase,
  ChargeProductionUseCase,
  FinishProductionOrderUseCase,
  IssueMaterialUseCase,
  OpenProductionOrderUseCase,
  ReleaseProductionOrderUseCase,
  ScrapMaterialUseCase,
} from '@/application/use-cases/produce'
import { TransferStockUseCase } from '@/application/use-cases/transfer-stock'
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
  readonly catalogEvents: InventoryCatalogEventHandlers
  readonly accessTokens: AccessTokenVerifier
  readonly createWarehouse: CreateWarehouseUseCase
  readonly deactivateWarehouse: DeactivateWarehouseUseCase
  readonly receiveStock: ReceiveStockUseCase
  readonly transferStock: TransferStockUseCase
  readonly adjustStock: AdjustStockUseCase
  readonly decideAdjustment: DecideAdjustmentUseCase
  readonly openCount: OpenStockCountUseCase
  readonly recordCount: RecordStockCountUseCase
  readonly closeCount: CloseStockCountUseCase
  readonly decideCount: DecideStockCountUseCase
  readonly defineAdjustmentPolicy: DefineAdjustmentPolicyUseCase
  readonly defineStockLevel: DefineStockLevelUseCase
  readonly defineItemTracking: DefineItemTrackingUseCase
  readonly openProduction: OpenProductionOrderUseCase
  readonly releaseProduction: ReleaseProductionOrderUseCase
  readonly issueMaterial: IssueMaterialUseCase
  readonly scrapMaterial: ScrapMaterialUseCase
  readonly chargeProduction: ChargeProductionUseCase
  readonly finishProduction: FinishProductionOrderUseCase
  readonly cancelProduction: CancelProductionOrderUseCase

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
    this.transferStock = new TransferStockUseCase(this.database, clock)
    this.adjustStock = new AdjustStockUseCase(this.database, clock)
    this.decideAdjustment = new DecideAdjustmentUseCase(this.database, clock)
    this.openCount = new OpenStockCountUseCase(this.database, clock)
    this.recordCount = new RecordStockCountUseCase(this.database, clock)
    this.closeCount = new CloseStockCountUseCase(this.database, clock)
    this.decideCount = new DecideStockCountUseCase(this.database, clock)
    this.defineAdjustmentPolicy = new DefineAdjustmentPolicyUseCase(this.database, clock)
    this.defineStockLevel = new DefineStockLevelUseCase(this.database, clock)
    this.defineItemTracking = new DefineItemTrackingUseCase(this.database, clock)
    this.openProduction = new OpenProductionOrderUseCase(this.database, clock)
    this.releaseProduction = new ReleaseProductionOrderUseCase(this.database, clock)
    this.issueMaterial = new IssueMaterialUseCase(this.database, clock)
    this.scrapMaterial = new ScrapMaterialUseCase(this.database, clock)
    this.chargeProduction = new ChargeProductionUseCase(this.database, clock)
    this.finishProduction = new FinishProductionOrderUseCase(this.database, clock)
    this.cancelProduction = new CancelProductionOrderUseCase(this.database, clock)
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
    this.catalogEvents = new InventoryCatalogEventHandlers(this.database, clock)
    this.eventHandlers = {
      handlers: {
        ...this.salesEvents.handlers,
        ...this.procurementEvents.handlers,
        ...this.catalogEvents.handlers,
      },
    }
  }

  onModuleInit(): Promise<void> {
    return this.database.ping()
  }

  onModuleDestroy(): Promise<void> {
    return this.database.close()
  }
}
