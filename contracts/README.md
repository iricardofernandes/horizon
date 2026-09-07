# `contracts/`

Versioned Zod schemas for every published event and every cross-module HTTP payload,
plus the per-module role and permission name maps.

This is the **only** thing modules are permitted to share (ADR 0002). Patterns are
copied between modules; contracts are versioned, because a wire contract has exactly
two sides and they must be able to disagree about which version they are on.

**Status: phase 1 — scaffold.** The package builds and publishes; it exports nothing
yet. Contents arrive in phase 3.

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
npm run build
npm version minor          # or major, per the policy below
npm publish                # to Verdaccio locally; to the CI registry in CI
```

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

A CI job compares each schema against the last published version and fails a breaking
change that is not accompanied by a major bump. Versioning that nothing enforces is
documentation, not a guarantee — the gate is the load-bearing part.

---

## Local development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

`docs/events.md` at the repository root is generated from these schemas, so the event
catalogue cannot drift from the code.
