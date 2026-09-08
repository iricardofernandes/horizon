import { z } from 'zod'

import { instantSchema, moneySchema, quantitySchema, uuidSchema } from './common'
import { eventEnvelopeSchema } from './envelope'
import { EVENTS } from './events'
import { paginationQuerySchema, problemDetailsSchema, validationProblemSchema } from './http'
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
