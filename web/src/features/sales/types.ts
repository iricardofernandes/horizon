export const SALES_API = '/api/horizon/sales'

export const QUOTE_STATUSES = [
  'draft',
  'pending',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'superseded',
] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

export const SHIPMENT_STATUSES = [
  'picking',
  'packed',
  'dispatched',
  'returned',
  'abandoned',
] as const
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number]

export type ApprovalState = 'none' | 'pending' | 'approved' | 'rejected' | 'not-required'
export type SalesOrderStatus = 'draft' | 'placed' | 'confirmed' | 'rejected' | 'cancelled'
export type FulfillmentState = 'unfulfilled' | 'partial' | 'fulfilled'

/**
 * The columns a board shows, and in the order work moves through them.
 *
 * What is finished is deliberately not a column. An offer that expired, was refused or was
 * replaced by a newer version is history, and three columns of history would bury the ones
 * that need attention; the same goes for a delivery nobody sent.
 */
export const QUOTE_COLUMNS: readonly QuoteStatus[] = ['draft', 'pending', 'sent', 'accepted']

export const SHIPMENT_COLUMNS: readonly ShipmentStatus[] = [
  'picking',
  'packed',
  'dispatched',
  'returned',
]

export type Money = { amount: string; currency: string }

export type QuoteLine = {
  lineId: string
  itemId: string
  quantity: string
  description: string
  unitPrice: string
  lineTotal: string
}

/** One version of one offer. Every version of the same offer shares a `rootId`. */
export type Quote = {
  id: string
  rootId: string
  version: number
  customerId: string
  currency: string
  sellerId: string | null
  discount: string
  freight: string
  carrier: string | null
  paymentTermDays: number[]
  notes: string | null
  net: string
  total: string
  status: QuoteStatus
  approvalState: ApprovalState
  approvalRequestedBy: string | null
  approvalRequestedAt: string | null
  approvalDecidedBy: string | null
  approvalDecidedAt: string | null
  approvalReason: string | null
  expiresAt: string
  supersedes: string | null
  supersededBy: string | null
  closureReason: string | null
  orderId: string | null
  sentAt: string | null
  createdAt: string
  updatedAt: string
  lines: QuoteLine[]
}

export type OrderLine = {
  lineId: string
  itemId: string
  quantity: string
  shipped: string
  allocated: string
  description?: string
  unitPrice?: Money
  lineTotal?: Money
}

export type Order = {
  id: string
  customerId: string
  fulfillmentWarehouseId: string
  quoteId: string | null
  sellerId: string | null
  currency: string | null
  discount: string
  freight: string
  carrier: string | null
  paymentTermDays: number[]
  issuedOn: string
  notes: string | null
  status: SalesOrderStatus
  fulfillment: FulfillmentState
  shipments: number
  confirmedAt: string | null
  version: number
  reservationId: string | null
  total: Money | null
  createdAt: string
  requestedLines: OrderLine[]
  confirmedLines: Array<{
    lineId: string
    itemId: string
    description: string
    quantity: string
    unitPrice: Money
    lineTotal: Money
  }>
}

export type Shipment = {
  id: string
  orderId: string
  warehouseId: string
  status: ShipmentStatus
  value: Money
  carrier: string | null
  trackingCode: string | null
  pickedBy: string
  packedBy: string | null
  dispatchedBy: string | null
  dispatchedOn: string | null
  returnedBy: string | null
  returnedOn: string | null
  closureReason: string | null
  createdAt: string
  lines: Array<{
    lineId: string
    itemId: string
    quantity: string
    description: string
    unitPrice: Money
    lineTotal: Money
  }>
}

export type SalesData = {
  quotes: Quote[]
  orders: Order[]
  shipments: Shipment[]
}

/** What the session may attempt; Sales still decides every command (ADR 0023, ADR 0045). */
export type SalesAbilities = {
  canWrite: boolean
  /** The signed-in subject, so nobody is offered the decision on their own document. */
  userId: string | null
}

/**
 * The short reference the rest of the product prints for a document.
 *
 * A delivery's receivable is numbered `SH-…` by Financial from the same eight characters,
 * so a reader who has the money in front of them can find the goods that made it owed.
 */
export function reference(prefix: string, id: string): string {
  return `${prefix}-${id.slice(-8).toUpperCase()}`
}

/**
 * One card per offer, not one per version.
 *
 * A negotiation that went four rounds is one offer a customer is thinking about, and a
 * board that showed all four would report four times the work there is. The newest version
 * is the offer; the rest is how it got there.
 */
export function currentVersions(quotes: readonly Quote[]): Quote[] {
  const latest = new Map<string, Quote>()
  for (const quote of quotes) {
    const held = latest.get(quote.rootId)
    if (!held || quote.version > held.version) latest.set(quote.rootId, quote)
  }
  return [...latest.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/** Every version of one offer, newest first: what was asked, and what it became. */
export function historyOf(quotes: readonly Quote[], rootId: string): Quote[] {
  return quotes
    .filter((quote) => quote.rootId === rootId)
    .sort((left, right) => right.version - left.version)
}

/** Offers held back by a discount somebody else has to allow (ADR 0045). */
export function awaitingApproval(quotes: readonly Quote[], userId: string | null): Quote[] {
  return currentVersions(quotes).filter(
    (quote) =>
      quote.status === 'pending' &&
      quote.approvalState === 'pending' &&
      quote.approvalRequestedBy !== userId,
  )
}

/** Orders a warehouse can still take goods off the shelf for. */
export function deliverable(orders: readonly Order[]): Order[] {
  return orders.filter((order) => order.status === 'confirmed' && order.fulfillment !== 'fulfilled')
}

/** What a line still owes: ordered, less what has gone and what another box is holding. */
export function outstandingOf(line: OrderLine): string {
  const outstanding = Number(line.quantity) - Number(line.shipped) - Number(line.allocated)
  return outstanding > 0 ? String(Number(outstanding.toFixed(6))) : '0'
}

/** How much of an order has left, as a percentage of its lines' quantities. */
export function shippedShare(lines: readonly OrderLine[]): number {
  const ordered = lines.reduce((sum, line) => sum + Number(line.quantity), 0)
  if (ordered === 0) return 0
  const shipped = lines.reduce((sum, line) => sum + Number(line.shipped), 0)
  return Math.min(100, Math.round((shipped / ordered) * 100))
}
