#!/usr/bin/env node
/**
 * Generate `docs/events.md` from the schemas.
 *
 * The event catalogue is documentation that goes stale the moment it is written by
 * hand, and a stale catalogue is worse than none — a consumer trusts it. Generating it
 * means it cannot drift from the code, and CI fails if the committed file differs from
 * what the current schemas produce.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(CONTRACTS, '..')

const { EVENTS, eventEnvelopeSchema } = await import(join(CONTRACTS, 'dist/index.mjs'))
const { z } = await import(join(CONTRACTS, 'node_modules/zod/index.js'))
const { version } = JSON.parse(readFileSync(join(CONTRACTS, 'package.json'), 'utf8'))

/** Render a JSON Schema object as a field table, one row per property. */
function fieldTable(jsonSchema) {
  const properties = jsonSchema.properties ?? {}
  const required = new Set(jsonSchema.required ?? [])
  const names = Object.keys(properties)
  if (names.length === 0) return '_No fields._'

  const rows = names.map((name) => {
    const field = properties[name]
    const type = field.enum ? field.enum.map((v) => `\`${v}\``).join(' \\| ') : (field.type ?? 'any')
    const constraints = []
    if (field.pattern) constraints.push(`pattern \`${field.pattern}\``)
    if (field.format) constraints.push(`format \`${field.format}\``)
    if (field.minLength !== undefined) constraints.push(`min length ${field.minLength}`)
    if (field.maxLength !== undefined) constraints.push(`max length ${field.maxLength}`)
    const notes = [field.description, ...constraints].filter(Boolean).join('. ')
    return `| \`${name}\` | ${type} | ${required.has(name) ? 'yes' : 'no'} | ${notes || '—'} |`
  })

  return ['| Field | Type | Required | Notes |', '|---|---|:--:|---|', ...rows].join('\n')
}

const envelopeJson = z.toJSONSchema(eventEnvelopeSchema, { io: 'input' })

const byModule = new Map()
for (const event of EVENTS) {
  const module = event.type.split('.')[0]
  if (!byModule.has(module)) byModule.set(module, [])
  byModule.get(module).push(event)
}

const sections = [...byModule.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([module, events]) => {
    const entries = events
      .sort((a, b) => a.type.localeCompare(b.type) || a.version - b.version)
      .map((event) => {
        const payload = z.toJSONSchema(event.payload, { io: 'input' })
        return [
          `### \`${event.type}\` — v${event.version}`,
          '',
          event.description,
          '',
          '**Payload**',
          '',
          fieldTable(payload),
        ].join('\n')
      })
    return [`## \`${module}\``, '', ...entries].join('\n')
  })

const document = `# Event catalogue

<!--
  GENERATED — do not edit.
  Source: contracts/src/events/, via contracts/scripts/generate-events-doc.mjs.
  Regenerate with: cd contracts && npm run docs:events
  CI fails if this file differs from what the current schemas produce.
-->

Every event Horizon publishes, generated from \`@horizon/contracts\` **v${version}**.

Events are the durable public interface between modules. Unlike an HTTP call there is no
caller to negotiate with — an event is emitted, and any number of consumers, including
ones written later, interpret it.

## Delivery guarantees

Every event is written to the publishing module's \`outbox\` table **inside the same
transaction** as the state change it describes, and relayed by a poller using
\`FOR UPDATE SKIP LOCKED\`. If the transaction commits the event exists; if it rolls back
neither exists. There is no third state.

The relay can publish and then crash before marking the row, so delivery is
**at-least-once**. Every consumer therefore writes an \`inbox\` row unique on
\`(source_module, event_id)\` inside the same transaction as the effect, which makes
processing exactly-once. Deduplicate on \`eventId\`.

Ordering is **not** guaranteed across aggregates. Where it matters the payload carries a
per-aggregate sequence number and the consumer rejects out-of-order arrivals.

## Versioning

| Change | Package version | \`eventVersion\` |
|---|---|---|
| New optional field | minor | unchanged |
| New event type | minor | n/a |
| Removed or renamed field, narrowed type, changed meaning | major | **new version** |

A published schema is **never** mutated in place. A breaking change publishes a new
\`eventVersion\`, and the producer emits both during a documented deprecation window.
\`scripts/check-contract-compat.mjs\` fails the build on a breaking change that is not
accompanied by a major bump.

## Envelope

Identical for every event.

${fieldTable(envelopeJson)}

${sections.join('\n\n')}
`

writeFileSync(join(REPO, 'docs/events.md'), document)
console.log(`wrote docs/events.md (${EVENTS.length} events from v${version})`)
