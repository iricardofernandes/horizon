import { z } from 'zod'

import { instantSchema, moneySchema, quantitySchema, uuidSchema } from './common'
import { eventEnvelopeSchema } from './envelope'
import { EVENTS } from './events'
import {
  fiscalArtifactKindSchema,
  fiscalArtifactMetadataSchema,
  fiscalCalculationInputSchema,
  fiscalCalculationOutcomeSchema,
  fiscalCancellationRequestSchema,
  fiscalCapabilityListSchema,
  fiscalCapabilitySchema,
  fiscalCommandAcceptedSchema,
  fiscalCorrectionRequestSchema,
  fiscalDocumentCreateRequestSchema,
  fiscalDocumentSchema,
  fiscalDocumentStatusSchema,
  fiscalDocumentTimelineSchema,
  fiscalDocumentTransitionSchema,
  fiscalLifecycleProblemCodeSchema,
  fiscalManualOriginRequestSchema,
  fiscalManualOriginSchema,
  fiscalReadyDocumentSchema,
  paginationQuerySchema,
  problemDetailsSchema,
  validationProblemSchema,
} from './http'
import { pageInfoSchema } from './http/pagination'
import { permissionIdSchema, roleAssignmentSchema } from './roles'

/**
 * The machine-readable catalogue of everything this package publishes.
 *
 * Two things read it, and that is the reason it exists:
 *
 *   - `scripts/snapshot.mjs` converts each entry to JSON Schema and writes
 *     `published-schemas.json` at publish time;
 *   - `scripts/check-contract-compat.mjs` diffs the current schemas against that
 *     snapshot and fails a breaking change that is not accompanied by a major bump.
 *
 * A schema that is exported but absent from this registry is unversioned and ungated —
 * so `src/registry.spec.ts` asserts that every exported schema appears here.
 */

export type SchemaKind = 'event' | 'http' | 'primitive' | 'authorization'

export interface RegistryEntry {
  readonly id: string
  readonly kind: SchemaKind
  readonly description: string
  readonly schema: z.ZodType
}

const staticEntries: readonly RegistryEntry[] = [
  {
    id: 'envelope',
    kind: 'event',
    description: 'The envelope every published event is wrapped in.',
    schema: eventEnvelopeSchema,
  },
  {
    id: 'primitive:uuid',
    kind: 'primitive',
    description: 'A public identifier. UUIDv7 in practice; the shape is not version-pinned.',
    schema: uuidSchema,
  },
  {
    id: 'primitive:instant',
    kind: 'primitive',
    description: 'A UTC instant, ISO 8601 with offset.',
    schema: instantSchema,
  },
  {
    id: 'primitive:money',
    kind: 'primitive',
    description: 'Integer minor units as a string, plus an explicit ISO 4217 currency.',
    schema: moneySchema,
  },
  {
    id: 'primitive:quantity',
    kind: 'primitive',
    description: 'A non-negative decimal quantity, as a string.',
    schema: quantitySchema,
  },
  {
    id: 'http:fiscal-calculation-input-v1',
    kind: 'http',
    description: 'Complete, versioned facts used to preview or persist a Fiscal calculation.',
    schema: fiscalCalculationInputSchema,
  },
  {
    id: 'http:fiscal-calculation-outcome-v1',
    kind: 'http',
    description: 'Supported Fiscal calculation or a typed unsupported outcome.',
    schema: fiscalCalculationOutcomeSchema,
  },
  {
    id: 'http:fiscal-capability-v1',
    kind: 'http',
    description: 'One exact enabled Fiscal capability and its evidence digests.',
    schema: fiscalCapabilitySchema,
  },
  {
    id: 'http:fiscal-capability-list-v1',
    kind: 'http',
    description: 'Enabled Fiscal capabilities with unsupported as the default.',
    schema: fiscalCapabilityListSchema,
  },
  {
    id: 'http:fiscal-manual-origin-request-v1',
    kind: 'http',
    description: 'Tenant-owned revisions used to create an audited manual simulation origin.',
    schema: fiscalManualOriginRequestSchema,
  },
  {
    id: 'http:fiscal-manual-origin-v1',
    kind: 'http',
    description: 'Identity and digest of a frozen manual simulation origin.',
    schema: fiscalManualOriginSchema,
  },
  {
    id: 'http:fiscal-document-create-request-v1',
    kind: 'http',
    description: 'Create a model-55 simulation draft from a frozen Sales or manual origin.',
    schema: fiscalDocumentCreateRequestSchema,
  },
  {
    id: 'http:fiscal-document-v1',
    kind: 'http',
    description: 'Tenant-scoped NF-e simulation document read model.',
    schema: fiscalDocumentSchema,
  },
  {
    id: 'http:fiscal-ready-document-v1',
    kind: 'http',
    description: 'A document made ready with frozen calculation and reconciliation digests.',
    schema: fiscalReadyDocumentSchema,
  },
  {
    id: 'http:fiscal-command-accepted-v1',
    kind: 'http',
    description: 'A durable asynchronous issuance or cancellation command.',
    schema: fiscalCommandAcceptedSchema,
  },
  {
    id: 'http:fiscal-cancellation-request-v1',
    kind: 'http',
    description: 'Reviewed reason for a model-55 simulation cancellation.',
    schema: fiscalCancellationRequestSchema,
  },
  {
    id: 'http:fiscal-correction-request-v1',
    kind: 'http',
    description: 'Create a corrected successor for an immutable rejected document.',
    schema: fiscalCorrectionRequestSchema,
  },
  {
    id: 'http:fiscal-document-status-v1',
    kind: 'http',
    description: 'Public state vocabulary for the NF-e simulation lifecycle.',
    schema: fiscalDocumentStatusSchema,
  },
  {
    id: 'http:fiscal-document-transition-v1',
    kind: 'http',
    description: 'One immutable transition in a Fiscal document timeline.',
    schema: fiscalDocumentTransitionSchema,
  },
  {
    id: 'http:fiscal-document-timeline-v1',
    kind: 'http',
    description: 'Ordered immutable transition history for one Fiscal document.',
    schema: fiscalDocumentTimelineSchema,
  },
  {
    id: 'http:fiscal-artifact-kind-v1',
    kind: 'http',
    description: 'Purpose of one retained NF-e simulation artifact.',
    schema: fiscalArtifactKindSchema,
  },
  {
    id: 'http:fiscal-artifact-metadata-v1',
    kind: 'http',
    description: 'Digest-verified metadata for a retained NF-e simulation artifact.',
    schema: fiscalArtifactMetadataSchema,
  },
  {
    id: 'http:fiscal-lifecycle-problem-code-v1',
    kind: 'http',
    description: 'Stable problem codes returned by NF-e simulation lifecycle commands.',
    schema: fiscalLifecycleProblemCodeSchema,
  },
  {
    id: 'http:problem-details',
    kind: 'http',
    description: 'RFC 9457 error body, returned by every endpoint in every module.',
    schema: problemDetailsSchema,
  },
  {
    id: 'http:validation-problem',
    kind: 'http',
    description: 'RFC 9457 body for a request that failed schema validation.',
    schema: validationProblemSchema,
  },
  {
    id: 'http:pagination-query',
    kind: 'http',
    description: 'Keyset pagination request parameters.',
    schema: paginationQuerySchema,
  },
  {
    id: 'http:page-info',
    kind: 'http',
    description: 'Keyset pagination response metadata.',
    schema: pageInfoSchema,
  },
  {
    id: 'authorization:role-assignment',
    kind: 'authorization',
    description: 'A { module, role } pair. Identity stores these opaquely.',
    schema: roleAssignmentSchema,
  },
  {
    id: 'authorization:permission-id',
    kind: 'authorization',
    description: 'The <module>:<subject>:<action> permission identifier format.',
    schema: permissionIdSchema,
  },
]

const eventEntries: readonly RegistryEntry[] = EVENTS.map((event) => ({
  id: event.id,
  kind: 'event' as const,
  description: event.description,
  schema: event.payload,
}))

export const SCHEMA_REGISTRY: readonly RegistryEntry[] = [...staticEntries, ...eventEntries]

/** JSON Schema for every registered entry, keyed by id. Stable output, sorted by id. */
export function toJsonSchemas(): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const entry of [...SCHEMA_REGISTRY].sort((a, b) => a.id.localeCompare(b.id))) {
    output[entry.id] = z.toJSONSchema(entry.schema, { io: 'input' })
  }
  return output
}
