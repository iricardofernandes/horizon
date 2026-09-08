import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import * as contracts from './index'
import { SCHEMA_REGISTRY, toJsonSchemas } from './registry'

/**
 * Schemas that are exported for composition but are deliberately not versioned
 * entries in their own right — they are building blocks of registered schemas, and
 * gating them separately would fail a build for a change already covered by the parent.
 *
 * Adding a name here is a decision: it says "this is not independently part of the wire
 * contract". Anything not listed must be registered, or the test fails.
 */
const NOT_INDEPENDENTLY_VERSIONED = new Set([
  'tenantIdSchema', // an alias of uuidSchema with a description
  'currencySchema', // only ever appears inside moneySchema
  'dateSchema', // no registered schema uses it yet
  'eventTypeSchema', // a naming rule, enforced at definition time
  'violationSchema', // only ever appears inside validationProblemSchema
  'cursorPayloadSchema', // the decoded form of an opaque cursor; not a contract
  'moduleNameSchema', // enumerated inside roleAssignmentSchema
  'permissionIdSchema', // registered under its own id below
  'roleAssignmentSchema',
  'paginationQuerySchema',
  'problemDetailsSchema',
  'validationProblemSchema',
  'eventEnvelopeSchema',
  'uuidSchema',
  'instantSchema',
  'moneySchema',
  'quantitySchema',
])

describe('schema registry', () => {
  it('registers every exported schema, or names it as deliberately unversioned', () => {
    // Widened deliberately: the inferred union of every export is far too specific for
    // TypeScript to relate back to z.ZodType, and this test is about runtime identity.
    const exported = Object.entries(contracts as Record<string, unknown>).filter(
      (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
    )
    const registered = new Set<unknown>(SCHEMA_REGISTRY.map((entry) => entry.schema))

    const unaccounted = exported
      .filter(([name, schema]) => !registered.has(schema) && !NOT_INDEPENDENTLY_VERSIONED.has(name))
      .map(([name]) => name)

    // A schema outside the registry is unversioned and ungated: the compatibility check
    // would not see a breaking change to it.
    expect(unaccounted).toEqual([])
  })

  it('has no duplicate ids', () => {
    const ids = SCHEMA_REGISTRY.map((entry) => entry.id)
    expect(ids).toHaveLength(new Set(ids).size)
  })

  it('produces byte-identical JSON Schema across runs', () => {
    // The compatibility gate diffs this output. Non-deterministic ordering would make
    // every build look like a breaking change.
    expect(JSON.stringify(toJsonSchemas())).toBe(JSON.stringify(toJsonSchemas()))
  })

  it('emits keys in sorted order', () => {
    const keys = Object.keys(toJsonSchemas())
    expect(keys).toEqual([...keys].sort())
  })
})
