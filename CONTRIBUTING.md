# Contributing

## The one rule

**A module never imports from another module's source tree.**

Everything else in this document follows from that. Cross-module communication happens
through HTTP via Kong, asynchronous events over RabbitMQ, or the published
`@horizon/contracts` package — never through the filesystem.

```bash
node scripts/check-boundaries.mjs
```

It runs in `pre-commit` and in CI, and it fails on:

| Violation | Why it matters |
|---|---|
| An import resolving outside its own project | The modules are not independently deployable if one needs another's source |
| A `file:` or `link:` dependency | It has no version, so a breaking change is invisible (ADR 0029) |
| `src/domain/` importing `application/`, `infrastructure/`, `main/`, NestJS, Drizzle, Zod or CASL | Dependencies point inward only (ADR 0031) |
| `toSnapshot()` called outside `infrastructure/` or `test/` | Aggregate data leaves only at the boundary (ADR 0031) |
| Importing a package absent from that project's `package.json` | npm's flat `node_modules` permits phantom dependencies (ADR 0004) |
| A directory with a `package.json` missing from `scripts/modules.json` | An undeclared project is an unchecked project |

---

## Setup

Node 24+. A Docker socket for the e2e suites.

```bash
make install     # npm ci in every project
make check       # boundaries + lint + typecheck + unit tests
```

There is no root `package.json` and no `node_modules` at the root — deliberately
(ADR 0001). The root holds only `scripts/`, `docs/`, `Makefile` and the hook
configuration. Work happens inside a project directory:

```bash
cd sales
npm install
npm run typecheck && npm run lint && npm test
```

---

## Repository layout

```
horizon/
├── identity/ catalog/ inventory/ sales/ webhooks/   independent NestJS services
├── web/                                             Next.js frontend
├── contracts/                                       published @horizon/contracts
├── gateway/                                         Kong declarative config
├── infra/                                           compose, observability, terraform
├── tooling/mcp-debugger/                            read-only MCP server
├── scripts/                                         boundary check + orchestration
└── docs/                                            plan, roadmap, ADRs, patterns
```

A folder exists only when its phase has begun. `financial/` and `fiscal/` are in
[`docs/roadmap.md`](docs/roadmap.md) and will not appear until then — an empty directory
reads as abandonment.

Inside a service:

```
src/
  domain/          entities, value objects, aggregates, domain events, repository interfaces
  application/     use cases, ports, application errors
  infrastructure/  drizzle repositories, controllers, amqp publishers and consumers, redis
  main/            nest modules, wiring, bootstrap
  core/            the tactical kernel — copied per module, permitted to diverge
test/
  factories/       make-<aggregate>.ts, plus the persisting <Aggregate>Factory
  repositories/    tenant-scoped in-memory implementations
```

---

## Writing code

The conventions are recorded in [ADR 0031](docs/adr/0031-layering-and-object-calisthenics.md);
the shorthand:

- **One level of indentation per method.** Extract instead of nesting.
- **No `else`.** Early return, guard clause, or polymorphism.
- **Wrap primitives that carry meaning.** `Cnpj`, `Email`, `Money`, `Quantity` — never a
  bare `string` for a domain concept. Validate in the constructor; stay immutable.
- **First-class collections.** A class holding a collection holds nothing else.
- **No getters or setters on entities.** Entities expose behaviour — `order.confirm()`,
  `stock.reserve()`. Data leaves through the aggregate's single
  `toSnapshot(): Readonly<Snapshot>`, consumed only by mappers and presenters.
- **Small units.** Classes under ~100 lines, methods under ~15, at most 5 instance fields.
  This is a lint warning, not a hard failure — one flat 18-line sequence beats two methods
  that are only ever called together.

Two calisthenics rules are relaxed on purpose: *one dot per line* (it fights Drizzle's
query builder) and *no abbreviations* (accepted domain terms like `cnpj` and `ncm` stay,
defined in [`docs/glossary.md`](docs/glossary.md)).

### Errors

Use cases return `Either<Error, Value>` for **expected** failures — not found, not
allowed, insufficient stock. Exceptions are for programmer error and infrastructure
failure. Controllers unwrap the `Either` and hand the left value to the global filter,
which maps error classes to RFC 9457 `application/problem+json`. **A controller never
chooses a status code.**

### Comments

No explanatory comments for self-evident code. Comments are reserved for:

- a non-obvious business rule, with a citation to its source;
- a deliberate deviation from the obvious implementation, and why;
- `TODO(phase-N):` markers.

### Language

English everywhere — code, identifiers, comments, commits, READMEs, ADRs. The only
exception is Brazilian fiscal terms with no English equivalent (`nfe`, `sped`, `cnpj`,
`icms`, `cfop`, `ncm`), defined in [`docs/glossary.md`](docs/glossary.md).

---

## Testing

| | |
|---|---|
| **Unit** | `*.spec.ts`, colocated, no I/O, tenant-scoped in-memory repositories |
| **Integration / e2e** | `test/**/*.e2e-spec.ts`, real PostgreSQL, Redis and RabbitMQ via Testcontainers |

The coverage gate — 80% — applies to `domain/` and `application/` only. Infrastructure
adapters are proven by the e2e suite, not by line counting.

**Every test creates its own tenant.** For every aggregate there must be a test that
writes under tenant A and asserts tenant B cannot read it. RLS is proven per aggregate,
never assumed from the existence of a policy.

Build test data through factories, never inline:

```ts
const order = makeOrder({ customerId: customer.id })          // unit
const order = await orderFactory.makeDrizzleOrder({ ... })    // e2e, via the real mapper
```

---

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint.
**Scopes are project names**, read from `scripts/modules.json`.

```
feat(inventory): reserve stock on order confirmation
fix(identity): invalidate the family on refresh token reuse
docs(repo): record the crypto-shredding decision
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Hooks, via lefthook:

| Hook | Runs |
|---|---|
| `pre-commit` | Biome on staged files, the boundary check, typecheck of affected projects |
| `commit-msg` | commitlint |
| `pre-push` | unit tests of affected projects |

Hooks are bypassable with `--no-verify`; CI is not. They exist to shorten the feedback
loop, not to be the gate — which is why anything slower than a few seconds lives in CI.

Install them once:

```bash
npx lefthook install
```

---

## Adding a module

1. Add it to `scripts/modules.json`. The boundary check, the CI matrix and the commit
   scopes all read that file, so they cannot disagree about which projects exist.
2. Follow `docs/patterns/new-module-checklist.md` (written in phase 5) **literally**. If
   the checklist has a gap, fix the checklist — do not work around it in the module.
3. Give it a README that says what it owns and, more importantly, **what it refuses to
   own**. A bounded context is defined by its refusals.
4. Add its ADRs if it introduces a decision that is not already recorded.

## Adding or changing an event

Schemas live in `contracts/` and are versioned there (ADR 0030).

- Additive change — a new optional field — is a **minor** package bump; `eventVersion` is
  unchanged.
- Breaking change publishes a **new `eventVersion`**, and the producer emits both during
  a deprecation window with a declared end date in `docs/events.md`.
- **A published schema is never mutated in place.**

CI compares each schema against the last published version and fails a breaking change
without a major bump.

---

## Security

- Never commit key material. `.gitignore` covers `*.pem`, `*.key` and `infra/keys/`, and
  a Gitleaks job runs in CI. Development keys come from `make keys`.
- Never commit a real value into a `.env.example`.
- Anything touching authentication, tenancy, RLS or the audit chain gets reviewed against
  [`docs/privacy.md`](docs/privacy.md) and the relevant ADR before merge.

If you find a security problem, open a private report rather than an issue.
