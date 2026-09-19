export const PROCUREMENT_API = '/api/horizon/procurement'

export const REQUISITION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'ordered',
  'rejected',
  'cancelled',
] as const
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number]

export const ORDER_STATUSES = [
  'draft',
  'pending',
  'approved',
  'received',
  'closed',
  'rejected',
  'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * The columns a board shows, and in the order work moves through them.
 *
 * What is finished is deliberately not a column: a board is for what still needs doing, and
 * four columns of history would bury the two that need attention. Everything closed is one
 * column at the end, and a filter reaches the rest.
 */
export const REQUISITION_COLUMNS: readonly RequisitionStatus[] = [
  'draft',
  'submitted',
  'approved',
  'ordered',
]

export const ORDER_COLUMNS: readonly OrderStatus[] = [
  'draft',
  'pending',
  'approved',
  'received',
  'closed',
]

export type RequisitionRow = {
  id: string
  requestedBy: string
  warehouseId: string
  neededBy: string
  status: RequisitionStatus
  submittedBy: string | null
  decidedBy: string | null
  orderId: string | null
  lines: number
  quotations: number
  createdAt: string
  updatedAt: string
}

export type RequisitionLine = {
  lineId: string
  itemId: string
  description: string
  quantity: string
}

export type RequisitionDetail = RequisitionRow & {
  justification: string | null
  decisionReason: string | null
  closureReason: string | null
  version: number
  data: RequisitionLine[]
}

export type Quotation = {
  id: string
  requisitionId: string
  supplierId: string
  supplierName: string
  reference: string
  quotedOn: string
  validUntil: string | null
  currency: string
  tax: string
  freight: string
  otherCharges: string
  discount: string
  total: string
  paymentTermDays: number[]
  leadTimeDays: number
  status: 'received' | 'selected' | 'declined'
  notes: string | null
}

export type ComparisonOffer = {
  quotationId: string
  supplierId: string
  supplierName: string
  unitPrice: string
  lineTotal: string
  /** The cheapest unit price for this line; ties are all marked. */
  best: boolean
}

export type ComparisonLine = {
  lineId: string
  itemId: string
  description: string
  quantity: string
  offers: ComparisonOffer[]
}

export type Comparison = {
  requisitionId: string
  currency: string | null
  quotations: Quotation[]
  lines: ComparisonLine[]
}

export type OrderRow = {
  id: string
  supplierId: string
  supplierName: string
  requisitionId: string | null
  warehouseId: string
  currency: string
  total: string
  issuedOn: string
  expectedOn: string
  status: OrderStatus
  approvalState: string
  approvalRequestedBy: string | null
  receipts: number
  lines: number
  updatedAt: string
}

export type OrderLine = {
  lineId: string
  itemId: string
  description: string
  quantity: string
  unitPrice: string
  lineTotal: string
  received: string
  outstanding: string
}

export type OrderDetail = OrderRow & {
  quotationId: string | null
  tax: string
  freight: string
  otherCharges: string
  discount: string
  paymentTermDays: number[]
  notes: string | null
  approvalDecidedBy: string | null
  approvalReason: string | null
  closureReason: string | null
  version: number
  data: OrderLine[]
}

export type Receipt = {
  id: string
  orderId: string
  receivedOn: string
  receivedBy: string
  currency: string
  value: string
  status: 'recorded' | 'returned'
  notes: string | null
  overrideReason: string | null
  returnReason: string | null
  lines: { lineId: string; itemId: string; description: string; quantity: string }[]
}

export type PurchasingData = {
  requisitions: RequisitionRow[]
  orders: OrderRow[]
}

/** What the session may attempt; Procurement still decides every command (ADR 0045). */
export type PurchasingAbilities = {
  canWrite: boolean
  canCommit: boolean
  canDecide: boolean
  /** The signed-in subject, so nobody is offered the decision on their own document. */
  userId: string | null
}

/** Everything waiting for somebody other than whoever asked for it. */
export function awaitingDecision(
  data: PurchasingData,
  userId: string | null,
): { requisitions: RequisitionRow[]; orders: OrderRow[] } {
  return {
    requisitions: data.requisitions.filter(
      (row) => row.status === 'submitted' && row.submittedBy !== userId,
    ),
    orders: data.orders.filter(
      (row) => row.status === 'pending' && row.approvalState === 'pending',
    ),
  }
}

/** How much of an order has arrived, as a percentage of its lines' quantities. */
export function receivedShare(lines: readonly OrderLine[]): number {
  const ordered = lines.reduce((sum, line) => sum + Number(line.quantity), 0)
  if (ordered === 0) return 0
  const received = lines.reduce((sum, line) => sum + Number(line.received), 0)
  return Math.min(100, Math.round((received / ordered) * 100))
}
