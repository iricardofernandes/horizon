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
