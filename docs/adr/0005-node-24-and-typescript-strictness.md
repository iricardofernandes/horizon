# 5. Node 24 and the TypeScript strictness baseline

- Status: accepted
- Date: 2026-09-07

## Context

Type safety in this project is not decoration: it is one of the mechanisms enforcing
architecture (ADR 0002 relies on `rootDir` and `paths`). The failure mode to avoid is
declaring `"strict": true` and then disabling several of its constituents, which is
common enough to be worth ruling out explicitly rather than by intention.

## Decision

**Node 24 LTS** across all projects and all Docker images (`node:24-alpine`).

**TypeScript strict**, plus:

- `noUncheckedIndexedAccess` — array and record access yields `T | undefined`
- `exactOptionalPropertyTypes` — `{ a?: string }` does not accept `{ a: undefined }`
- `verbatimModuleSyntax` — import elision is explicit

`rootDir: "src"`; `paths` mapping `@/*` to the module's own `src/*` and nothing else.

No `strict` sub-flag is disabled anywhere.

## Consequences

- `noUncheckedIndexedAccess` makes `items[i].doThing()` a type error until the index
  is checked. This is friction on exactly the pattern that produces undefined-access
  crashes at runtime, and it is most valuable in the in-memory repositories, where
  array indexing is the storage mechanism.
- `exactOptionalPropertyTypes` is noisy at ORM and DTO boundaries, where "absent" and
  "explicitly undefined" genuinely differ. Mappers absorb the noise; domain types are
  written so the distinction is meaningful rather than accidental.
- `verbatimModuleSyntax` interacts with NestJS. `emitDecoratorMetadata` needs a
  constructor parameter's type to survive to runtime as a value import. Under
  `verbatimModuleSyntax`, a plain `import { Foo }` is preserved, which is correct —
  but an `import type { Foo }` erases it and dependency injection then fails at
  runtime with an unhelpful message. Biome's `useImportType` rule would happily make
  that conversion. It is therefore **disabled in the service modules' `biome.json`**,
  with a comment naming this ADR. `contracts/`, `web/` and `tooling/mcp-debugger/`
  keep the rule on, as they use no parameter-decorator injection.
- Node 24 gives a stable `node:test`-independent toolchain, native `fetch`, and
  `crypto.randomUUID`; UUIDv7 comes from a library (ADR 0009).

## Alternatives considered

**`strict` without the three additional flags.** The common default. Rejected:
`noUncheckedIndexedAccess` catches a real and frequent defect class, and
`verbatimModuleSyntax` makes an existing decision explicit rather than adding one.

**Dropping `verbatimModuleSyntax` to avoid the Nest interaction.** Rejected: the
interaction is a one-line lint configuration, and the flag removes a whole category
of ambiguity about what survives compilation.

**Node 22.** Also LTS. Rejected for no strong reason beyond preferring the longer
remaining support window; nothing in the design depends on a Node 24 feature.
