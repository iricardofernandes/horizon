import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'
import { defineEvent } from './define'

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const simulationDocumentFact = {
  documentId: uuidSchema,
  rootDocumentId: uuidSchema,
  revision: z.number().int().positive(),
  originModule: z.enum(['sales', 'fiscal']),
  originDocumentType: z.enum(['shipment', 'manual-simulation']),
  originId: uuidSchema,
  originPurpose: z.enum(['original', 'manual']),
  model: z.literal('55'),
  environment: z.literal('simulation'),
  simulated: z.literal(true),
  adapterVersion: z.string().min(1).max(80),
  statusDigest: sha256Schema,
  observedAt: instantSchema,
}

export const fiscalDocumentAuthorized = defineEvent({
  type: 'fiscal.document.simulation-authorized',
  version: 1,
  description:
    'The deterministic simulator authorized an NF-e model 55. This simulated fact never releases a shipment or creates a stock or money effect.',
  payload: z.strictObject({
    ...simulationDocumentFact,
    authorityReference: z.string().min(1).max(256),
    protocolDigest: sha256Schema,
  }),
})

export const fiscalDocumentRejected = defineEvent({
  type: 'fiscal.document.simulation-rejected',
  version: 1,
  description:
    'The deterministic simulator rejected an NF-e model 55; the immutable document may be followed by a corrected revision.',
  payload: z.strictObject({
    ...simulationDocumentFact,
    authorityReference: z.string().min(1).max(256).nullable(),
    rejectionCode: z.string().min(1).max(40),
    rejectionReason: z.string().min(1).max(1000),
    responseDigest: sha256Schema,
  }),
})

export const fiscalDocumentCancelled = defineEvent({
  type: 'fiscal.document.simulation-cancelled',
  version: 1,
  description:
    'The deterministic simulator accepted a cancellation linked to an authorized NF-e model 55. Original authorization evidence remains immutable.',
  payload: z.strictObject({
    ...simulationDocumentFact,
    cancellationReference: z.string().min(1).max(256),
    cancellationProtocolDigest: sha256Schema,
  }),
})

export const fiscalDocumentHomologationObserved = defineEvent({
  type: 'fiscal.document.homologation-observed',
  version: 1,
  description:
    'One parsed SP NF-e homologation exchange was retained. This observation has no fiscal value and never releases a shipment, stock or money effect.',
  payload: z.strictObject({
    documentId: uuidSchema,
    exchangeId: uuidSchema,
    service: z.enum(['authorization', 'receipt', 'protocol', 'status', 'event']),
    model: z.literal('55'),
    environment: z.literal('homologation'),
    fiscalValue: z.literal(false),
    adapterVersion: z.string().min(1).max(160),
    decision: z.enum([
      'authorized',
      'rejected',
      'cancelled',
      'pending',
      'available',
      'unavailable',
      'unknown',
    ]),
    statusCode: z.string().regex(/^[0-9]{3}$/),
    documentStatusCode: z
      .string()
      .regex(/^[0-9]{3}$/)
      .nullable(),
    eventStatusCode: z
      .string()
      .regex(/^[0-9]{3}$/)
      .nullable(),
    requestDigest: sha256Schema,
    responseDigest: sha256Schema,
    protocolDigest: sha256Schema.nullable(),
    observedAt: instantSchema,
  }),
})

const productionDocumentFact = z.strictObject({
  documentId: uuidSchema,
  documentRevision: z.number().int().positive(),
  originModule: z.literal('sales'),
  originId: uuidSchema,
  originDigest: sha256Schema,
  orderVersion: z.number().int().positive(),
  establishmentId: uuidSchema,
  model: z.literal('55'),
  environment: z.literal('production'),
  responseDigest: sha256Schema,
  observedAt: instantSchema,
})

export const fiscalDocumentProductionOutcome = defineEvent({
  type: 'fiscal.document.production-outcome',
  version: 1,
  description:
    'Future production authority outcome for one frozen Sales shipment. Phase 43 does not publish this event or enable production transmission; Sales uses the exact origin and document revision to maintain a fail-closed release projection.',
  payload: z.discriminatedUnion('outcome', [
    productionDocumentFact.extend({
      outcome: z.literal('authorized'),
      authorityReference: z.string().min(1).max(256),
      protocolDigest: sha256Schema,
    }),
    productionDocumentFact.extend({
      outcome: z.literal('rejected'),
      authorityReference: z.string().min(1).max(256).nullable(),
      protocolDigest: sha256Schema.nullable(),
    }),
    productionDocumentFact.extend({
      outcome: z.literal('cancelled'),
      authorityReference: z.string().min(1).max(256),
      protocolDigest: sha256Schema,
    }),
  ]),
})

export const fiscalInboundMatched = defineEvent({
  type: 'fiscal.inbound.matched',
  version: 1,
  description:
    "A reviewer reconciled a supplier NF-e with Procurement receipts. It links fiscal evidence to operational facts and never creates a receipt, stock movement or payable: those remain `procurement.receipt.recorded` and Financial's. `decision` is `overridden` when a difference was kept with a reason. `authorityStatus` stays `unverified` until an inbound consultation capability exists. `accessKey` is null for a natural-person issuer, whose key embeds a CPF.",
  payload: z.strictObject({
    importId: uuidSchema,
    reconciliationId: uuidSchema,
    /** Null when the issuer is a natural person: that key embeds the CPF. */
    accessKey: z
      .string()
      .regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/)
      .nullable(),
    supplierPartyId: uuidSchema,
    decision: z.enum(['matched', 'overridden']),
    receipts: z.array(z.strictObject({ receiptId: uuidSchema, orderId: uuidSchema })).min(1),
    payableTitleIds: z.array(uuidSchema),
    authorityEnvironment: z.enum(['production', 'homologation']),
    signature: z.literal('valid-unanchored'),
    authorityStatus: z.literal('unverified'),
    comparisonDigest: sha256Schema,
    reviewedBy: z.string().min(1).max(255),
    observedAt: instantSchema,
  }),
})

const linkedOutcomeFact = {
  documentId: uuidSchema,
  rootDocumentId: uuidSchema,
  revision: z.number().int().positive(),
  linkedOriginId: uuidSchema,
  kind: z.enum(['sale-return', 'purchase-return', 'value-complement']),
  references: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('document'), documentId: uuidSchema }),
        z.strictObject({ type: z.literal('supplier-invoice'), importId: uuidSchema }),
      ]),
    )
    .min(1),
  source: z.strictObject({
    module: z.enum(['sales', 'procurement', 'fiscal']),
    documentType: z.enum(['shipment', 'receipt', 'review']),
    id: uuidSchema,
  }),
  correlations: z.array(
    z.strictObject({
      module: z.enum(['inventory', 'financial']),
      sourceEvent: z.string().min(1).max(80),
      correlationId: uuidSchema,
    }),
  ),
  model: z.literal('55'),
  environment: z.literal('simulation'),
  simulated: z.literal(true),
  adapterVersion: z.string().min(1).max(80),
  statusDigest: sha256Schema,
  observedAt: instantSchema,
}

export const fiscalLinkedDocumentOutcome = defineEvent({
  type: 'fiscal.linked-document.simulation-outcome',
  version: 1,
  description:
    'The deterministic simulator decided an NF-e model 55 that returns or complements an earlier document. It correlates the owners of the stock and money effects (`correlations`) and never creates, repeats or reverses one: those remain the Sales, Procurement, Inventory and Financial facts. It carries no access key, XML or personal data.',
  payload: z.discriminatedUnion('outcome', [
    z.strictObject({
      ...linkedOutcomeFact,
      outcome: z.literal('authorized'),
      authorityReference: z.string().min(1).max(256),
      protocolDigest: sha256Schema,
    }),
    z.strictObject({
      ...linkedOutcomeFact,
      outcome: z.literal('rejected'),
      authorityReference: z.string().min(1).max(256).nullable(),
      protocolDigest: sha256Schema.nullable(),
    }),
    z.strictObject({
      ...linkedOutcomeFact,
      outcome: z.literal('cancelled'),
      authorityReference: z.string().min(1).max(256),
      protocolDigest: sha256Schema,
    }),
  ]),
})

const consumerOutcomeFact = {
  documentId: uuidSchema,
  rootDocumentId: uuidSchema,
  revision: z.number().int().positive(),
  source: z.strictObject({
    module: z.literal('sales'),
    documentType: z.literal('shipment'),
    id: uuidSchema,
  }),
  correlations: z.array(
    z.strictObject({
      module: z.enum(['inventory', 'financial']),
      sourceEvent: z.literal('sales.shipment.dispatched'),
      correlationId: uuidSchema,
    }),
  ),
  model: z.literal('65'),
  environment: z.literal('simulation'),
  simulated: z.literal(true),
  adapterVersion: z.string().min(1).max(80),
  statusDigest: sha256Schema,
  observedAt: instantSchema,
}

export const fiscalConsumerDocumentOutcome = defineEvent({
  type: 'fiscal.consumer-document.simulation-outcome',
  version: 1,
  description:
    'The deterministic simulator decided an NFC-e model 65 for one Sales shipment to a final consumer. The sale keeps one stock and one money effect, both from `sales.shipment.dispatched` (`correlations`); this fact never creates, repeats or reverses one. It carries no access key, QR code, XML or consumer data.',
  payload: z.discriminatedUnion('outcome', [
    z.strictObject({
      ...consumerOutcomeFact,
      outcome: z.literal('authorized'),
      authorityReference: z.string().min(1).max(256),
      protocolDigest: sha256Schema,
    }),
    z.strictObject({
      ...consumerOutcomeFact,
      outcome: z.literal('rejected'),
      authorityReference: z.string().min(1).max(256).nullable(),
      rejectionCode: z.string().min(1).max(40),
      protocolDigest: sha256Schema.nullable(),
    }),
    z.strictObject({
      ...consumerOutcomeFact,
      outcome: z.literal('cancelled'),
      authorityReference: z.string().min(1).max(256),
      protocolDigest: sha256Schema,
    }),
  ]),
})
