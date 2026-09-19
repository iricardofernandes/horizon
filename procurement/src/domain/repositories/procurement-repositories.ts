import type { GoodsReceipt } from '../entities/goods-receipt'
import type { PurchaseOrder } from '../entities/purchase-order'
import type { PurchaseRequisition } from '../entities/purchase-requisition'
import type { Supplier } from '../entities/supplier'
import type { SupplierQuotation } from '../entities/supplier-quotation'
import type { LineDescription } from '../value-objects/procurement-values'

export abstract class RequisitionsRepository {
  abstract findById(id: string): Promise<PurchaseRequisition | null>
  abstract findForUpdate(id: string): Promise<PurchaseRequisition | null>
  abstract create(requisition: PurchaseRequisition): Promise<void>
  abstract save(requisition: PurchaseRequisition): Promise<void>
}

export abstract class QuotationsRepository {
  abstract findById(id: string): Promise<SupplierQuotation | null>
  abstract findForUpdate(id: string): Promise<SupplierQuotation | null>
  /** Every quotation against one requisition, which is what a comparison is made of. */
  abstract listForRequisition(requisitionId: string): Promise<readonly SupplierQuotation[]>
  abstract create(quotation: SupplierQuotation): Promise<void>
  abstract save(quotation: SupplierQuotation): Promise<void>
}

export abstract class PurchaseOrdersRepository {
  abstract findById(id: string): Promise<PurchaseOrder | null>
  abstract findForUpdate(id: string): Promise<PurchaseOrder | null>
  abstract create(order: PurchaseOrder): Promise<void>
  abstract save(order: PurchaseOrder): Promise<void>
}

export abstract class ReceiptsRepository {
  abstract findById(id: string): Promise<GoodsReceipt | null>
  abstract findForUpdate(id: string): Promise<GoodsReceipt | null>
  abstract listForOrder(orderId: string): Promise<readonly GoodsReceipt[]>
  abstract create(receipt: GoodsReceipt): Promise<void>
  abstract save(receipt: GoodsReceipt): Promise<void>
}

/** A projection fed by `parties/`; Procurement never registers a supplier (ADR 0040). */
export abstract class SuppliersRepository {
  abstract findById(id: string): Promise<Supplier | null>
  abstract create(supplier: Supplier): Promise<void>
  abstract save(supplier: Supplier): Promise<void>
  abstract erase(supplier: Supplier): Promise<void>
}

/** What the catalogue calls an item, so a buyer orders something that exists. */
export interface CatalogItemProjection {
  readonly tenantId: string
  readonly itemId: string
  readonly description: LineDescription
  readonly active: boolean
}

export abstract class CatalogItemsRepository {
  abstract findById(id: string): Promise<CatalogItemProjection | null>
  abstract recordItem(item: {
    tenantId: string
    itemId: string
    description: LineDescription
  }): Promise<void>
  abstract deactivate(itemId: string): Promise<void>
}

/**
 * The value above which an order needs a second person (ADR 0023 keeps roles static; this
 * is the one purchasing decision a workspace does configure).
 *
 * It is per currency because a threshold is an amount, and an amount without a currency
 * decides nothing. A currency with no policy requires approval for every order: the safe
 * reading of "nobody has decided yet" is that somebody should look.
 */
export interface ApprovalPolicy {
  readonly tenantId: string
  readonly currency: string
  readonly threshold: bigint
  readonly updatedBy: string
  readonly updatedAt: Date
}

export abstract class ApprovalPoliciesRepository {
  abstract find(currency: string): Promise<ApprovalPolicy | null>
  abstract list(): Promise<readonly ApprovalPolicy[]>
  abstract save(policy: ApprovalPolicy): Promise<void>
}
