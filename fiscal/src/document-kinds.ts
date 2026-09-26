import type {
  FiscalDocumentKind,
  FiscalDocumentKindEntry,
  FiscalLinkedKind,
} from '@horizon/contracts'

/** Calculation scenarios reviewed for each supported linked kind (simulation only). */
export const PHASE45_SCENARIOS = {
  'sale-return': 'rtc-v0057-model55-sale-return',
  'purchase-return': 'rtc-v0057-model55-purchase-return',
  'value-complement': 'rtc-v0057-model55-value-complement',
} as const satisfies Record<FiscalLinkedKind, string>

export const PHASE45_FIXTURES = {
  'sale-return': 'rtc-v0057-model55-sale-return-sp-2026-01',
  'purchase-return': 'rtc-v0057-model55-purchase-return-sp-2026-01',
  'value-complement': 'rtc-v0057-model55-value-complement-sp-2026-01',
} as const satisfies Record<FiscalLinkedKind, string>

const none = { module: 'none', sourceEvent: null } as const

/**
 * What each NF-e kind means, what it must reference and who owns its effects. A kind
 * that is not `supported` here cannot reach a draft: there is no owner fact to derive it
 * from, or no reviewed rule and capability to issue it.
 */
export const DOCUMENT_KINDS: readonly FiscalDocumentKindEntry[] = [
  {
    kind: 'sale',
    model: '55',
    supported: true,
    purpose: '1',
    direction: 'outbound',
    operation: 'normal-sale',
    reference: 'none',
    source: 'sales.fiscal-origin.recorded (original) or a reviewed manual origin',
    stockOwner: { module: 'inventory', sourceEvent: 'sales.shipment.dispatched' },
    moneyOwner: { module: 'financial', sourceEvent: 'sales.shipment.dispatched' },
    reason: null,
  },
  {
    kind: 'sale-return',
    model: '55',
    supported: true,
    purpose: '4',
    direction: 'inbound',
    operation: 'sale-return',
    reference: 'sale-document',
    source: 'sales.fiscal-origin.recorded (return)',
    stockOwner: { module: 'inventory', sourceEvent: 'sales.shipment.returned' },
    moneyOwner: { module: 'financial', sourceEvent: 'sales.shipment.returned' },
    reason: null,
  },
  {
    kind: 'purchase-return',
    model: '55',
    supported: true,
    purpose: '4',
    direction: 'outbound',
    operation: 'purchase-return',
    reference: 'supplier-invoice',
    source: 'procurement.receipt.returned',
    stockOwner: { module: 'inventory', sourceEvent: 'procurement.receipt.returned' },
    moneyOwner: { module: 'financial', sourceEvent: 'procurement.receipt.returned' },
    reason: null,
  },
  {
    kind: 'value-complement',
    model: '55',
    supported: true,
    purpose: '2',
    direction: 'outbound',
    operation: 'value-complement',
    reference: 'sale-document',
    source: 'reviewed Fiscal request with a reason',
    stockOwner: none,
    moneyOwner: none,
    reason: null,
  },
  unsupported(
    'remittance',
    '1',
    'Inventory publishes no fact for goods leaving to a third party, so there is no owner origin.',
  ),
  unsupported(
    'remittance-return',
    '4',
    'There is no remittance to return: its origin does not exist yet.',
  ),
  unsupported(
    'quantity-complement',
    '2',
    'A quantity complement would move stock that no owner fact accounts for.',
  ),
  unsupported('tax-complement', '2', 'No reviewed rule or source covers a tax-only complement.'),
  unsupported('adjustment', '3', 'No reviewed adjustment scenario or source exists.'),
  unsupported(
    'credit-note',
    '5',
    'The reform credit note has no reviewed rule, capability or owner fact yet.',
  ),
  unsupported(
    'debit-note',
    '6',
    'The reform debit note has no reviewed rule, capability or owner fact yet.',
  ),
]

/** Post-authorization event flows with an approved specification, per model. */
export const EVENT_FLOWS = [
  { model: '55', flows: ['cancellation', 'correction-letter'] },
  { model: '65', flows: [] },
  { model: 'nfse', flows: [] },
] as const

export class UnsupportedDocumentKind extends Error {
  readonly code = 'KIND_UNSUPPORTED'
  constructor(readonly kind: string) {
    super(`Fiscal document kind ${kind} is unsupported`)
  }
}

/** Returns the catalogued entry of a kind that may be issued, or throws. */
export function supportedKind(kind: string): FiscalDocumentKindEntry {
  const entry = DOCUMENT_KINDS.find((candidate) => candidate.kind === kind)
  if (!entry?.supported) throw new UnsupportedDocumentKind(kind)
  return entry
}

export function isLinkedKind(kind: FiscalDocumentKind): kind is FiscalLinkedKind {
  return kind === 'sale-return' || kind === 'purchase-return' || kind === 'value-complement'
}

export function hasEventFlow(model: string, flow: 'cancellation' | 'correction-letter'): boolean {
  const entry = EVENT_FLOWS.find((candidate) => candidate.model === model)
  return entry ? (entry.flows as readonly string[]).includes(flow) : false
}

function unsupported(
  kind: FiscalDocumentKind,
  purpose: FiscalDocumentKindEntry['purpose'],
  reason: string,
): FiscalDocumentKindEntry {
  return {
    kind,
    model: '55',
    supported: false,
    purpose,
    direction: null,
    operation: null,
    reference: 'none',
    source: null,
    stockOwner: none,
    moneyOwner: none,
    reason,
  }
}
