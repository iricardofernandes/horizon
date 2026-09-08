# `contracts/`

Versioned Zod schemas for every published event and every cross-module HTTP payload,
plus the per-module role and permission name maps.

This is the **only** thing modules are permitted to share (ADR 0002). Patterns are
copied between modules; contracts are versioned, because a wire contract has exactly
two sides and they must be able to disagree about which version they are on.

**Status: phase 3 — v0.1.0 published.** The envelope, the shared primitives, the RFC 9457
and pagination shapes, the role names for all five modules, and one event. Consumed by
`identity/` at an exact pin.

---

## What this package owns

- **The event envelope** — `eventId`, `eventType`, `eventVersion`, `occurredAt`,
  `tenantId`, `traceId`, `payload` (ADR 0030).
- **Event payload schemas**, one per event type per version.
- **Cross-module HTTP payload schemas** — the request and response shapes modules use
  to talk to each other through Kong.
- **Role and permission names** per module, so `identity/` can mint a well-formed token
  without knowing what any role means.

## What it does not own

- **What a role permits.** Only the names live here. The `role → permissions` map is
  owned by the module that defines those subjects, and validated there on arrival
  (ADR 0023).
- **Domain types.** An aggregate is not a wire shape. Nothing in a module's `domain/`
  imports this package, and the boundary check enforces it.
- **Runtime behaviour.** Schemas and inferred types only — no clients, no transports,
  no helpers that reach the network.

---

## Distribution

Published to a **registry**, consumed at a **pinned version**:

```bash
npm version minor          # or patch/major, per the policy below
npm run release:prepare    # regenerate published-schemas.json and docs/events.md
make publish-contracts     # from the repository root, to the local Verdaccio
```

`release:prepare` moves the compatibility baseline. Doing it **without** a version bump
is exactly what the gate catches, so the order matters: bump first, then regenerate.

A consuming module depends on an exact version and points the `@horizon` scope at the
registry through its own `.npmrc`. **`file:` and `link:` dependencies are rejected by
`scripts/check-boundaries.mjs`.**

## Version policy (ADR 0030)

| Change | Package version | `eventVersion` |
|---|---|---|
| New optional field | minor | unchanged |
| New event type | minor | n/a |
| Removed or renamed field, narrowed type, changed meaning | major | **new version** |

A published schema is **never** mutated in place. A breaking change publishes a new
`eventVersion`, and the producer emits both during a deprecation window with a declared
end date recorded in `docs/events.md`.

Under **0.x the breaking position is `minor`**, not `major` — a caret range on 0.x admits
only patch releases, so treating 0.2.0 as compatible with 0.1.0 would be wrong. From 1.0.0
onwards the table above applies literally.

`scripts/check-contract-compat.mjs` diffs every schema against `published-schemas.json`
and fails a change whose severity outruns the version bump. Versioning that nothing
enforces is documentation, not a guarantee — the gate is the load-bearing part, which is
why it has its own tests (`node --test 'scripts/**/*.test.mjs'`).

The baseline is a **committed file**, not a package fetched from a registry, so the check
needs no infrastructure: it runs in a fresh checkout, in a sparse checkout, and offline.

```bash
node scripts/check-contract-compat.mjs   # from the repository root
```

Severity is judged conservatively, because these schemas both validate incoming messages
and construct outgoing ones — a change that is safe in one direction is often breaking in
the other:

| Change | Severity |
|---|---|
| Property removed; type changed; enum value removed | breaking |
| Optional property became required; new **required** property | breaking |
| Constraint tightened (`maxLength` down, `pattern` added or changed) | breaking |
| New **optional** property; new enum value; constraint loosened | additive |
| New schema | additive |

---

## Local development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build

npm run docs:events        # regenerate docs/events.md
npm run schemas:snapshot   # regenerate the compatibility baseline
```

`docs/events.md` is generated from these schemas, so the event catalogue cannot drift from
the code — CI regenerates it and fails if the committed file differs.

## Adding an event

```ts
export const orderConfirmed = defineEvent({
  type: 'sales.order.confirmed',   // <module>.<aggregate>.<past-tense-verb>, enforced
  version: 1,
  description: 'Stock is reserved and the order is committed.',
  payload: z.object({ orderId: uuidSchema, total: moneySchema }),
})
```

Then add it to `EVENTS` in `src/events/index.ts`. The registry is what the snapshot, the
compatibility gate and the generated catalogue all walk, so an event that is defined but
not registered is unversioned and ungated — `src/registry.spec.ts` fails on it.
