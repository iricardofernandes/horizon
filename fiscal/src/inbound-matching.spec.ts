import { describe, expect, it } from 'vitest'
import {
  AllocationError,
  compareAllocations,
  type InvoiceLineInput,
  type OpenReceiptLine,
  proposeAllocations,
} from './inbound-matching'

const grain = '0190a000-0000-7000-8000-000000000001'
const sack = '0190a000-0000-7000-8000-000000000002'
const line = (overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({
  number: 1,
  productCode: 'GR-01',
  ncm: '09011110',
  quantity: '6.0000',
  gross: '60.00',
  discount: '0.00',
  ...overrides,
})
const open = (overrides: Partial<OpenReceiptLine> = {}): OpenReceiptLine => ({
  receiptId: 'receipt-1',
  orderId: 'order-1',
  lineId: 'line-1',
  itemId: grain,
  receivedOn: '2026-09-20',
  openQuantity: '6',
  unitPriceMinor: '1000',
  currency: 'BRL',
  ...overrides,
})
const ncmByItem = new Map([
  [grain, '09011110'],
  [sack, '63051000'],
])

describe('inbound allocation proposals', () => {
  it('prefers a remembered mapping and converts supplier units', () => {
    const [proposal] = proposeAllocations({
      lines: [line({ quantity: '2', gross: '60.00' })],
      receiptLines: [open()],
      mappings: [{ productCode: 'GR-01', itemId: grain, factor: '3' }],
      ncmByItem,
    })
    expect(proposal).toEqual({
      lineNumber: 1,
      basis: 'mapping',
      allocations: [{ receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '6' }],
    })
  })

  it('falls back to a unique NCM and fills the oldest receipts first', () => {
    const [proposal] = proposeAllocations({
      lines: [line({ quantity: '8', gross: '80.00' })],
      receiptLines: [
        open({
          receiptId: 'receipt-2',
          lineId: 'line-2',
          receivedOn: '2026-09-21',
          openQuantity: '4',
        }),
        open({ openQuantity: '6' }),
      ],
      mappings: [],
      ncmByItem,
    })
    expect(proposal?.basis).toBe('ncm')
    expect(proposal?.allocations).toEqual([
      { receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '6' },
      { receiptId: 'receipt-2', receiptLineId: 'line-2', quantity: '2' },
    ])
  })

  it('keeps partial receipts of the same order line apart', () => {
    const receipts = [
      open({ openQuantity: '6' }),
      open({ receiptId: 'receipt-2', openQuantity: '4' }),
    ]
    const [proposal] = proposeAllocations({
      lines: [line({ quantity: '10', gross: '100.00' })],
      receiptLines: receipts,
      mappings: [],
      ncmByItem,
    })
    expect(proposal?.allocations).toEqual([
      { receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '6' },
      { receiptId: 'receipt-2', receiptLineId: 'line-1', quantity: '4' },
    ])
    const comparison = compareAllocations({
      lines: [line({ quantity: '10', gross: '100.00' })],
      allocations: (proposal?.allocations ?? []).map((allocation) => ({
        ...allocation,
        lineNumber: 1,
      })),
      unmatchedLines: [],
      receiptLines: receipts,
      mappings: [],
    })
    expect(comparison.clean).toBe(true)
  })

  it('proposes nothing for an ambiguous NCM or when nothing is open', () => {
    const lines = [line()]
    const ambiguous = proposeAllocations({
      lines,
      receiptLines: [open(), open({ lineId: 'line-9', itemId: 'other-item' })],
      mappings: [],
      ncmByItem: new Map([...ncmByItem, ['other-item', '09011110']]),
    })
    expect(ambiguous[0]).toEqual({ lineNumber: 1, basis: 'none', allocations: [] })
    const closed = proposeAllocations({
      lines,
      receiptLines: [open({ openQuantity: '0' })],
      mappings: [],
      ncmByItem,
    })
    expect(closed[0]?.basis).toBe('none')
  })
})

describe('inbound allocation comparison', () => {
  it('is clean when quantity, value and item agree', () => {
    const comparison = compareAllocations({
      lines: [line()],
      allocations: [
        { lineNumber: 1, receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '6' },
      ],
      unmatchedLines: [],
      receiptLines: [open()],
      mappings: [],
    })
    expect(comparison.clean).toBe(true)
    expect(comparison.lines[0]).toMatchObject({
      invoicedQuantity: '6',
      allocatedQuantity: '6',
      invoicedValueMinor: '6000',
      expectedValueMinor: '6000',
      differences: [],
    })
  })

  it('reports quantity, value, item and unmatched differences', () => {
    const comparison = compareAllocations({
      lines: [
        line({ quantity: '7', gross: '77.00' }),
        line({ number: 2, productCode: 'SC-02', ncm: '63051000', quantity: '1', gross: '3.50' }),
      ],
      allocations: [
        { lineNumber: 1, receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '6' },
      ],
      unmatchedLines: [2],
      receiptLines: [open()],
      mappings: [{ productCode: 'GR-01', itemId: sack, factor: '1' }],
    })
    expect(comparison.clean).toBe(false)
    expect(comparison.lines[0]?.differences).toEqual(['quantity', 'value', 'item'])
    expect(comparison.lines[1]?.differences).toEqual(['unmatched'])
  })

  it('tolerates one minor unit of rounding per allocation', () => {
    const comparison = compareAllocations({
      lines: [line({ quantity: '3', gross: '10.00' })],
      allocations: [
        { lineNumber: 1, receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '3' },
      ],
      unmatchedLines: [],
      receiptLines: [open({ unitPriceMinor: '333' })],
      mappings: [],
    })
    expect(comparison.lines[0]?.differences).toEqual([])
  })

  it('refuses over-allocation, unknown lines and lines left unaccounted', () => {
    const base = { lines: [line()], receiptLines: [open()], mappings: [] }
    expect(() =>
      compareAllocations({
        ...base,
        allocations: [
          { lineNumber: 1, receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '4' },
          { lineNumber: 1, receiptId: 'receipt-1', receiptLineId: 'line-1', quantity: '3' },
        ],
        unmatchedLines: [],
      }),
    ).toThrow(AllocationError)
    expect(() => compareAllocations({ ...base, allocations: [], unmatchedLines: [] })).toThrow(
      'allocated or declared unmatched',
    )
    expect(() =>
      compareAllocations({
        ...base,
        allocations: [
          { lineNumber: 1, receiptId: 'receipt-x', receiptLineId: 'line-1', quantity: '1' },
        ],
        unmatchedLines: [],
      }),
    ).toThrow('not open')
    expect(() => compareAllocations({ ...base, allocations: [], unmatchedLines: [1, 5] })).toThrow(
      'unknown invoice line',
    )
  })
})
