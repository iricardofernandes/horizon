/**
 * Pure proposal and comparison for supplier invoices against received purchase lines.
 * Quantities are scaled to six decimals and money to minor units, both as bigint, so a
 * comparison is exact and reproducible from its stored inputs.
 */

const QUANTITY_SCALE = 1_000_000n

export type InvoiceLineInput = {
  number: number
  productCode: string
  ncm: string
  quantity: string
  gross: string
  discount: string
}

export type OpenReceiptLine = {
  receiptId: string
  orderId: string
  lineId: string
  itemId: string
  receivedOn: string
  /** Received minus returned minus allocated to other committed reconciliations. */
  openQuantity: string
  unitPriceMinor: string
  currency: string
}

export type ItemMapping = { productCode: string; itemId: string; factor: string }

export type Allocation = {
  receiptId: string
  receiptLineId: string
  quantity: string
}

export type LineProposal = {
  lineNumber: number
  basis: 'mapping' | 'ncm' | 'none'
  allocations: Allocation[]
}

export type Difference = 'quantity' | 'value' | 'item' | 'unmatched'

export type LineComparison = {
  lineNumber: number
  productCode: string
  factor: string
  invoicedQuantity: string
  allocatedQuantity: string
  invoicedValueMinor: string
  expectedValueMinor: string
  allocations: Array<Allocation & { itemId: string; orderId: string; unitPriceMinor: string }>
  differences: Difference[]
}

export type TaxComparison = {
  compared: boolean
  reason?: string
  orderId?: string
  estimateDigest?: string
  components: Array<{
    code: (typeof COMPARED_TAXES)[number][0]
    invoicedMinor: string
    expectedMinor: string
    differenceMinor: string
  }>
  clean: boolean
}

export type Comparison = {
  currency: 'BRL'
  lines: LineComparison[]
  invoicedValueMinor: string
  expectedValueMinor: string
  clean: boolean
  taxes?: TaxComparison
}

/** The supplier NF-e totals compared with Fiscal's estimate, as component and total field. */
const COMPARED_TAXES = [
  ['ICMS', 'icms'],
  ['ICMS_ST', 'icmsSt'],
  ['IPI', 'ipi'],
  ['PIS', 'pis'],
  ['COFINS', 'cofins'],
] as const

/**
 * The supplier's taxes against the purchase order's estimate (Phase 87, ADR 0073), one
 * component at a time, naming each difference. Compared only when the reconciliation is of one
 * order that carries an estimate; the estimate is of the whole order.
 */
export function compareTaxes(input: {
  totals: Record<(typeof COMPARED_TAXES)[number][1], string>
  orderIds: readonly string[]
  estimate: {
    orderId: string
    components: ReadonlyArray<{ code: string; amount: { amount: string } }>
    resultDigest: string
  } | null
}): TaxComparison {
  if (input.orderIds.length !== 1)
    return {
      compared: false,
      reason: 'The NF-e is reconciled against more than one purchase order',
      components: [],
      clean: true,
    }
  if (!input.estimate)
    return {
      compared: false,
      reason: 'The purchase order carries no tax estimate',
      components: [],
      clean: true,
    }
  const expected = new Map<string, bigint>()
  for (const component of input.estimate.components)
    expected.set(
      component.code,
      (expected.get(component.code) ?? 0n) + BigInt(component.amount.amount),
    )
  const components = COMPARED_TAXES.map(([code, field]) => {
    const invoiced = minor(input.totals[field])
    const estimated = expected.get(code) ?? 0n
    return {
      code,
      invoicedMinor: String(invoiced),
      expectedMinor: String(estimated),
      differenceMinor: String(invoiced - estimated),
    }
  }).filter((component) => component.invoicedMinor !== '0' || component.expectedMinor !== '0')
  return {
    compared: true,
    orderId: input.estimate.orderId,
    estimateDigest: input.estimate.resultDigest,
    components,
    clean: components.every((component) => component.differenceMinor === '0'),
  }
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}

/** Proposes allocations; the reviewer confirms or replaces them before anything is kept. */
export function proposeAllocations(input: {
  lines: InvoiceLineInput[]
  receiptLines: OpenReceiptLine[]
  mappings: ItemMapping[]
  ncmByItem: ReadonlyMap<string, string | null>
}): LineProposal[] {
  const remaining = new Map(
    input.receiptLines.map((line) => [
      lineKey(line.receiptId, line.lineId),
      quantity(line.openQuantity),
    ]),
  )
  // Stable sort: receipts of the same day keep the order in which they were recorded.
  const ordered = [...input.receiptLines].sort((left, right) =>
    left.receivedOn.localeCompare(right.receivedOn),
  )
  return input.lines.map((line) => {
    const mapping = input.mappings.find((entry) => entry.productCode === line.productCode)
    let basis: LineProposal['basis'] = 'none'
    let itemId: string | null = null
    if (mapping) {
      basis = 'mapping'
      itemId = mapping.itemId
    } else {
      const items = new Set(
        ordered
          .filter((open) => (remaining.get(lineKey(open.receiptId, open.lineId)) ?? 0n) > 0n)
          .filter((open) => input.ncmByItem.get(open.itemId) === line.ncm)
          .map((open) => open.itemId),
      )
      if (items.size === 1) {
        basis = 'ncm'
        itemId = [...items][0] ?? null
      }
    }
    if (!itemId) return { lineNumber: line.number, basis: 'none', allocations: [] }
    let wanted = convert(line.quantity, mapping?.factor ?? '1')
    const allocations: Allocation[] = []
    for (const open of ordered) {
      if (wanted === 0n || open.itemId !== itemId) continue
      const key = lineKey(open.receiptId, open.lineId)
      const available = remaining.get(key) ?? 0n
      const take = available < wanted ? available : wanted
      if (take === 0n) continue
      remaining.set(key, available - take)
      wanted -= take
      allocations.push({
        receiptId: open.receiptId,
        receiptLineId: open.lineId,
        quantity: formatQuantity(take),
      })
    }
    return { lineNumber: line.number, basis: allocations.length > 0 ? basis : 'none', allocations }
  })
}

/**
 * Compares the reviewer's allocations with what arrived. Over-allocation is refused
 * outright; every other disagreement is a difference that only an override can keep.
 */
export function compareAllocations(input: {
  lines: InvoiceLineInput[]
  allocations: ReadonlyArray<Allocation & { lineNumber: number }>
  unmatchedLines: readonly number[]
  receiptLines: OpenReceiptLine[]
  mappings: ItemMapping[]
  /** Reviewer-confirmed supplier-to-buyer unit factors; they win over remembered ones. */
  factors?: ReadonlyMap<number, string>
}): Comparison {
  const numbers = new Set(input.lines.map((line) => line.number))
  const allocated = new Set(input.allocations.map((allocation) => allocation.lineNumber))
  const unmatched = new Set(input.unmatchedLines)
  for (const number of [...allocated, ...unmatched])
    if (!numbers.has(number)) throw new AllocationError('Allocation names an unknown invoice line')
  for (const number of numbers)
    if (allocated.has(number) === unmatched.has(number))
      throw new AllocationError('Every invoice line must be allocated or declared unmatched')

  const byLine = new Map(
    input.receiptLines.map((line) => [lineKey(line.receiptId, line.lineId), line]),
  )
  const used = new Map<string, bigint>()
  for (const allocation of input.allocations) {
    const key = lineKey(allocation.receiptId, allocation.receiptLineId)
    const open = byLine.get(key)
    if (!open)
      throw new AllocationError(
        'Allocation names a receipt line that is not open for this supplier',
      )
    const amount = quantity(allocation.quantity)
    if (amount <= 0n) throw new AllocationError('Allocated quantity must be positive')
    const total = (used.get(key) ?? 0n) + amount
    if (total > quantity(open.openQuantity))
      throw new AllocationError('Allocation exceeds the quantity still open on the receipt line')
    used.set(key, total)
    if (open.currency !== 'BRL') throw new AllocationError('Only BRL receipts can be compared')
  }

  const lines = input.lines.map((line): LineComparison => {
    const mapping = input.mappings.find((entry) => entry.productCode === line.productCode)
    const factor = input.factors?.get(line.number) ?? mapping?.factor ?? '1'
    if (quantity(factor) === 0n) throw new AllocationError('Unit factor must be positive')
    const invoiced = convert(line.quantity, factor)
    const invoicedValue = minor(line.gross) - minor(line.discount)
    const mine = input.allocations
      .filter((allocation) => allocation.lineNumber === line.number)
      .map((allocation) => {
        const open = byLine.get(
          lineKey(allocation.receiptId, allocation.receiptLineId),
        ) as OpenReceiptLine
        return {
          ...allocation,
          itemId: open.itemId,
          orderId: open.orderId,
          unitPriceMinor: open.unitPriceMinor,
        }
      })
    const allocatedQuantity = mine.reduce((sum, entry) => sum + quantity(entry.quantity), 0n)
    const expectedValue = mine.reduce(
      (sum, entry) => sum + roundHalfUp(quantity(entry.quantity) * BigInt(entry.unitPriceMinor)),
      0n,
    )
    const differences: Difference[] = []
    if (unmatched.has(line.number)) differences.push('unmatched')
    else {
      if (allocatedQuantity !== invoiced) differences.push('quantity')
      const tolerance = BigInt(mine.length)
      const gap = invoicedValue - expectedValue
      if (gap > tolerance || gap < -tolerance) differences.push('value')
      if (mapping && mine.some((entry) => entry.itemId !== mapping.itemId)) differences.push('item')
      if (new Set(mine.map((entry) => entry.itemId)).size > 1) differences.push('item')
    }
    return {
      lineNumber: line.number,
      productCode: line.productCode,
      factor,
      invoicedQuantity: formatQuantity(invoiced),
      allocatedQuantity: formatQuantity(allocatedQuantity),
      invoicedValueMinor: invoicedValue.toString(),
      expectedValueMinor: expectedValue.toString(),
      allocations: mine.map(({ lineNumber: _line, ...entry }) => entry),
      differences: [...new Set(differences)],
    }
  })
  const invoicedValue = lines.reduce((sum, line) => sum + BigInt(line.invoicedValueMinor), 0n)
  const expectedValue = lines.reduce((sum, line) => sum + BigInt(line.expectedValueMinor), 0n)
  return {
    currency: 'BRL',
    lines,
    invoicedValueMinor: invoicedValue.toString(),
    expectedValueMinor: expectedValue.toString(),
    clean: lines.every((line) => line.differences.length === 0),
  }
}

/** A receipt line is identified by its receipt and the order line it received. */
function lineKey(receiptId: string, lineId: string): string {
  return `${receiptId}:${lineId}`
}

export function quantity(value: string): bigint {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(value)
  if (!match) throw new AllocationError('Quantity must be a non-negative decimal')
  return BigInt(match[1] ?? '0') * QUANTITY_SCALE + BigInt((match[2] ?? '').padEnd(6, '0'))
}

export function formatQuantity(value: bigint): string {
  const whole = value / QUANTITY_SCALE
  const fraction = (value % QUANTITY_SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/** Invoice quantity in the buyer's unit: the supplier quantity times the mapping factor. */
function convert(invoiceQuantity: string, factor: string): bigint {
  return (quantity(invoiceQuantity) * quantity(factor) + QUANTITY_SCALE / 2n) / QUANTITY_SCALE
}

function minor(value: string): bigint {
  const match = /^(\d{1,13})\.(\d{2})$/.exec(value)
  if (!match) throw new AllocationError('Invoice amount must have two decimals')
  return BigInt(match[1] ?? '0') * 100n + BigInt(match[2] ?? '0')
}

/** A scaled quantity times a minor-unit price, rounded half up to minor units. */
function roundHalfUp(scaled: bigint): bigint {
  return (scaled + QUANTITY_SCALE / 2n) / QUANTITY_SCALE
}
