# Horizon — phase plan

Horizon is built in phases. A phase produces working, reviewed artefacts; a folder
exists only once its phase begins. Declared-but-unbuilt scope lives in
[roadmap.md](roadmap.md).

Each phase below lists **deliverables** (what is produced), **exit criteria** (what
must be demonstrably true to move on), and **non-goals** (what is explicitly not
done, so that its absence reads as sequencing rather than omission).

---

## Deviation from the brief's ordering

The brief's §14 lists Phase 1 as *Scaffold* and Phase 2 as *Platform*, while Phase 2
itself instructs: "Validate this in a throwaway directory **before** freezing
Phase 1's configs." Taken with §0's "Phase 1 produces the scaffold only. I review
the working tree **before** the initial commit", those two cannot both hold: the
scaffold contains `infra/docker-compose.yml`, `gateway/kong.yml`, the OTel Collector
config and the Grafana provisioning tree, and freezing those before validation means
committing configuration that has never started.

Resolved by promoting the throwaway validation to an explicit **Phase 0**, producing
findings rather than files, so that platform configuration written later is known to
work.

**What actually happened.** Phase 1 turned out to freeze no platform configuration —
`docker-compose.yml`, `kong.yml` and the observability tree are all Phase 2 deliverables,
and Phase 1 shipped only a `kong.yml` skeleton. With nothing frozen, a throwaway
directory would have been a copy of Phase 2's first hour, so Phase 0's validation was
done directly in `infra/` and iterated there until `make smoke` passed. The findings it
was meant to produce were recorded as they arrived — see Phase 2 below, and ADR 0036.

This is the only ordering change. Everything else follows §14.

---

## Phase 0 — Platform spike — **absorbed into Phase 2**

Intended as a throwaway spike whose findings would protect Phase 1's configuration.
Phase 1 froze none, so the spike had nothing to protect and was done in place. Kept here
for the record of what it was for; its exit criteria are folded into Phase 2's.


Run entirely in a scratch directory. Nothing here is committed; the output is a
findings note and a set of known-good config fragments to be transcribed in Phase 1.

**Deliverables**

- A `docker-compose.yml` in a scratch directory bringing up: PostgreSQL 17, Redis 7,
  RabbitMQ 4 with management, Verdaccio, Kong in DB-less mode, OTel Collector,
  Jaeger, Prometheus, Loki, Grafana Alloy, Grafana.
- A throwaway HTTP service emitting OTel traces, metrics and logs through the
  Collector, proxied by Kong, with a JWT validated against a static JWKS document.
- Findings note recording, for each service: the exact image tag used, whether an
  Alpine variant exists, the healthcheck that actually reports readiness, and every
  config key that differed from the vendor's quickstart.

**Exit criteria**

- `docker compose up` reaches all-healthy from a cold start with no manual step.
- A request through Kong produces one trace visible in Jaeger, its logs queryable in
  Loki by `traceId`, and RED metrics visible in Prometheus — all via the Collector,
  with nothing talking to a backend directly.
- Kong rejects a request with a token signed by an unknown `kid` and accepts one
  signed by a known `kid`, with `kong.yml` as the only configuration source.
- `npm publish` to Verdaccio and `npm install` of that package from a clean cache
  both succeed.
- Grafana starts with datasources and at least one dashboard provisioned from files,
  with no clicking.

**Non-goals**

- No Horizon code, no domain modelling, no repository files.
- No Terraform, no CI.
- No attempt to make the spike reusable — it is deleted after Phase 1 transcribes it.

---

## Phase 1 — Scaffold

Directory structure, real configuration, complete documentation. No behaviour.

**Deliverables**

Per backend service module (`identity/`, `catalog/`, `inventory/`, `sales/`,
`webhooks/`):

- `package.json` with real dependencies and the scripts `dev`, `build`, `test`,
  `test:e2e`, `lint`, `typecheck`, `db:generate`, `db:migrate`
- `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `rootDir: "src"`, and an
  `@/*` alias resolving only inside the module
- `biome.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `drizzle.config.ts`
- `Dockerfile` (multi-stage, `node:24-alpine`, non-root, init process) and
  `.dockerignore`
- `.env.example`, exhaustive, no real values
- `README.md`: purpose, what the context owns, what it explicitly does not own, how
  to run, environment variables, published and consumed events, endpoints table
  (empty with a note), local development steps
- `src/` skeleton (`domain/`, `application/`, `infrastructure/`, `main/`) with
  `.gitkeep`

For the non-service projects, per the profile table in
[architecture.md](architecture.md): `contracts/` (package, no Dockerfile, no
Drizzle), `web/` (Next.js app), `gateway/` (Kong declarative config plus a lint
script), `infra/` (compose, observability configs, Terraform tree, scripts),
`tooling/mcp-debugger/` (package, stdio + HTTP entry points, disabled by default).

At the root:

- `README.md` — what Horizon is, C4 level 1 and level 2 Mermaid diagrams, module
  table, quick start, decisions linked to their ADRs, current phase, roadmap link,
  placeholder for the golden-path trace screenshot
- `CONTRIBUTING.md`, `LICENSE` (MIT), `.gitignore`, `.editorconfig`, `Makefile`
- `lefthook.yml`, `commitlint.config.js`
- `docs/`: `plan.md`, `roadmap.md`, `architecture.md`, `glossary.md`, `privacy.md`,
  `reference-analysis.md`, `adr/`, `patterns/`
- `.github/workflows/` — functional CI
- `scripts/check-boundaries.mjs` — working

**Exit criteria**

- Every project installs, typechecks and lints from a clean clone. Test commands run
  and report zero tests without erroring.
- `node scripts/check-boundaries.mjs` exits 0 on the clean tree, and exits non-zero
  when a deliberate cross-module import is introduced.
- Every Dockerfile builds with its own directory as the sole build context.
- Every README is finished — no "TODO" and no placeholder prose. A reader who opens
  only `sales/README.md` understands what `sales` owns and what it refuses to own.
- Every ADR in §2 of the brief exists and is written.
- CI runs green on the scaffold.
- The working tree is reviewed **before** the initial commit.

**Non-goals**

- No entities, no value objects, no use cases, no controllers, no repositories, no
  migrations, no Nest modules beyond an empty bootstrap.
- No running services — the scaffold is not started in this phase.
- No `financial/` or `fiscal/` folder.

---

## Phase 2 — Platform — **complete**

The committed, scripted, reproducible local stack. `make up` reaches all-healthy from
cold in about 30 seconds; `make smoke` asserts 43 things about it and gates CI.

**What the platform turned up, none of which was visible from the scaffold:**

- **Kong OSS verifies EdDSA but cannot fetch a JWKS document.** `openid-connect` is
  Enterprise-only. ADR 0018 survives; ADR 0008's "validates against JWKS" did not, and
  the gateway configuration is now rendered from the public keys. See ADR 0036.
- **`deck` requires a `secret` on a JWT credential** even for asymmetric algorithms that
  ignore it. Rendered as a random value rather than a committed placeholder.
- **`localhost` resolves to `::1` inside the Verdaccio image** while Verdaccio binds IPv4
  only, so a `localhost` healthcheck fails against a healthy service. Every healthcheck
  now uses `127.0.0.1`.
- **The OTel Collector and Alloy are distroless** — no shell, no health subcommand — so
  no container healthcheck is expressible. Their readiness is asserted from the host in
  `smoke.sh` instead, and this is stated rather than quietly skipped.
- **Verdaccio needs npm to send a token even for anonymous publish.**
  `make publish-contracts` passes a meaningless local one; nothing is committed.
- **Host port collisions are normal on a developer machine.** Every published port is
  overridable through `infra/.env`.

Turn Phase 0's findings into the committed, scripted, reproducible local stack.

**Deliverables**

- `infra/docker-compose.yml` (platform) and `infra/docker-compose.apps.yml`
  (module overlay), healthchecks on every service, `depends_on:
  condition: service_healthy`.
- `infra/observability/`: Collector pipeline config, Prometheus scrape config, Loki
  config, Alloy config, Grafana datasource and dashboard provisioning.
- `gateway/kong.yml` with services, routes, upstreams and the plugin set: JWT
  against JWKS, rate limiting, request size limiting, correlation id, CORS,
  OpenTelemetry.
- `infra/scripts/smoke.sh` — brings the stack up, waits for health, asserts each
  service answers, tears down, and returns a non-zero exit code on any failure.
- `infra/scripts/generate-keys.sh` — Ed25519 dev keys into a gitignored path.
- `make up`, `make down`, `make smoke`.

**Exit criteria**

- `make up && make smoke` passes from a cold start on a machine with no Horizon
  images cached.
- Verdaccio accepts a publish and serves an install.
- Kong validates a token signed with a dev key against the dev JWKS document.
- A trace emitted by a throwaway request appears in Jaeger, its log line in Loki
  keyed by the same `traceId`, its metrics in Prometheus — via the Collector only.
- CI runs the smoke script.

**Non-goals**

- No module runs against the stack yet.
- No Terraform.
- No alerting rules — dashboards only.

---

## Phase 3 — Contracts v0.1.0 — **complete**

`@horizon/contracts@0.1.0` published, consumed by `identity/` at an exact pin, with the
compatibility gate live in CI and `docs/events.md` generated from the schemas.

**What it turned up:**

- **The gate needed to be testable, so the analysis was split out.**
  `scripts/lib/contract-diff.mjs` holds the pure diff and version rules;
  `contract-diff.test.mjs` covers them with `node:test`. A gate whose whole job is to be
  trustworthy should not itself be untested.
- **Under 0.x the breaking position is `minor`, not `major`.** A caret range on 0.x admits
  only patch releases, so treating 0.2.0 as compatible with 0.1.0 would be wrong. The rule
  is encoded and tested.
- **`.swcrc` was excluding spec files from the transform**, not just from the build output,
  so Vitest could not compile a test the moment the first one existed. The exclusion moved
  to the build command, where it belongs.
- **A scoped registry in `.npmrc` beats `--registry` on the command line**, so publishing
  needs `--@horizon:registry`. And `npm_config_@horizon:registry` is not a valid shell
  identifier, so it can only be set through `$GITHUB_ENV` or `env`.
- **The documentation link checker treated a regex in backticks as a link.** Generated
  schema tables contain patterns like `(?:[01]\d|2[0-3])`, which is link-shaped. It now
  masks code spans before scanning.

**Deliverables**

- `contracts/` publishing `@horizon/contracts`: the event envelope schema
  (`eventId`, `eventType`, `eventVersion`, `occurredAt`, `tenantId`, `traceId`,
  `payload`), base cross-module HTTP payload schemas, per-module role and permission
  name maps, and inferred types.
- Published to Verdaccio at `0.1.0` and consumed by one module at a pinned version.
- `scripts/check-contract-compat.mjs` plus the CI job that compares each schema
  against the last published version and fails a breaking change without a major
  bump.
- `docs/events.md` generated from the schemas.

**Exit criteria**

- A module installs `@horizon/contracts@0.1.0` from the registry and typechecks
  against it.
- The compatibility gate fails on a deliberately introduced breaking change and
  passes when the change is accompanied by a major bump.
- `docs/events.md` regenerates identically from a clean checkout.

**Non-goals**

- No real events yet beyond the envelope and one sample.
- No public npm publication.

---

## Phase 4 — Identity — **complete**

The reference module. Every cross-cutting pattern is invented here once and copied
afterwards, so it is reviewed harder than anything else.

**Deliverables**

- Tenants, users, sessions.
- Argon2id hashing with rehash-on-login below policy.
- EdDSA signing, `/.well-known/jwks.json`, `kid` rotation with an overlap window.
- Refresh tokens: opaque, hashed in Redis, keyed by family, rotated on use, with
  reuse detection that invalidates the family and emits a security audit event.
- `jti` denylist in Redis with TTL to token expiry, and the documented asymmetric
  failure mode (closed for privileged operations, open for read-only).
- API keys: `hz_<env>_<prefix>_<secret>`, prefix indexed in plaintext, secret
  Argon2id-hashed, explicit scopes, rotation and revocation, throttled
  `last_used_at`.
- RBAC assignment storage as opaque `{ module, role }` pairs.
- **And the patterns**: RLS with forced policies and a non-`BYPASSRLS` application
  role; `TenantAwareTransaction` with an unexported Drizzle client; the outbox table
  and relay; the inbox table; the append-only `audit_log` with per-tenant hash chain
  and a verification command; crypto-shredding with `data_subject_keys`;
  `Idempotency-Key` handling; the resilience policy (timeouts, breaker, backoff with
  jitter, bounded prefetch, bulkheads); OpenTelemetry wiring; graceful shutdown;
  health probes.

**Exit criteria**

- Cross-tenant test per aggregate: written under tenant A, invisible to tenant B.
- A test proves the application role cannot bypass RLS, and that no repository can
  reach a raw connection.
- Refresh-token reuse detection is proven by test: replaying a rotated token kills
  the family.
- The audit verification command detects a deliberately tampered row and names the
  first broken link.
- An erasure test destroys a subject key, leaves the hash chain verifiable, and
  makes the plaintext unrecoverable.
- Outbox relay tested with two concurrent relays against the same table with no
  double publish and no lost row.
- Domain and application coverage at or above 80%.

**Non-goals**

- No UI.
- No cross-module events consumed — identity only publishes.
- No per-tenant custom roles (roles are static by decision; see ADR 0022).

---

## Phase 5 — Pattern extraction — **complete**

**Deliverables**

`docs/patterns/`, one document per pattern, each written so another module can
reimplement it locally without importing anything: tenant transaction and RLS,
transactional outbox, inbox idempotency, audit hash chain, crypto-shredding,
resilience policy, error taxonomy and RFC 9457 mapping, tactical kernel, testing
strategy, module bootstrap checklist.

**Exit criteria**

- Each document names the Phase 4 files it was extracted from and states what must
  change per module.
- A new-module checklist exists and is followed literally in Phase 6.

**Non-goals**

- No shared library. The patterns are copied, not imported — that is the point of
  the topology (ADR 0001).

---

## Phase 6 — Catalog — **complete**

The simplest business module. It exists to prove the template is followable.

**What following the template turned up:**

- **A database rename is a release sequence, not one migration.** The executable
  PostgreSQL exercise keeps old and new writers compatible, backfills in resumable
  batches, validates the cutover and only then drops the old column. The resulting
  [recipe](patterns/zero-downtime-migration.md) is now part of the checklist.
- **Forced RLS changes how backfills run.** A migration owner is not an excuse for a
  cross-tenant connection. The recipe requires tenant transactions or a temporary,
  explicitly reviewed maintenance policy instead of `BYPASSRLS`.
- **The reusable patterns had real gaps.** Catalog forced the recipes to specify the
  issuer-to-`kid` binding, denylist key ownership, broker poison-message policy and the
  shutdown order for AMQP channels. Those fixes live in `docs/patterns/`, not as private
  Catalog workarounds.

**Deliverables**

- Products, services, units of measure, price lists, NCM classification.
- The full pattern set from Phase 5, reimplemented locally.
- OpenAPI generated from decorators and Zod schemas.

**Exit criteria**

- The module was built by following the Phase 5 checklist, and every gap found in
  the checklist was fixed in `docs/patterns/` rather than worked around.
- Boundary check passes; the isolated CI job with a sparse checkout of `catalog/`
  alone passes.
- Cross-tenant tests per aggregate; coverage gate met.

**Non-goals**

- No pricing rules engine, no tax logic (that is `fiscal/`, roadmap).
- No stock — quantities live in `inventory/`.

---

## Phase 7 — Inventory and Sales

First real choreography across module and database boundaries.

**Completed.** `@horizon/contracts@0.3.0` fixes the order/reservation wire protocol.
Inventory derives availability and moving-average cost from its append-only movement
ledger, holds every order line atomically and serializes competing reservations with row
locks. Sales owns customers, expiring quotes, monotonic order transitions and immutable
commercial snapshots; customer PII uses per-subject authenticated encryption and blind
indexes so erasure can crypto-shred the key without rewriting history. Both modules use
forced RLS, transactional inbox/outbox adapters, durable RabbitMQ topology, bounded
redelivery, publisher confirms, timeouts, circuit breakers and messaging metrics.

`make test-phase7` starts two isolated PostgreSQL databases and RabbitMQ and proves the
whole choreography. It deliberately crashes a relay after broker confirmation, restarts
it, observes one inbox effect from the duplicate, completes the shipment and verifies
one trace id across both services. The per-module E2E suites separately prove RLS,
rollback, append-only movements, quote persistence and live crypto-shredding.

**Deliverables**

- `inventory/`: warehouses, stock balances, movements, reservations, cost method.
- `sales/`: customers, quotes, sales orders, invoicing trigger.
- Published events per `@horizon/contracts`, dispatched via each module's outbox.
- `inventory` consumes sales events idempotently through its inbox; `sales` consumes
  reservation outcomes.
- Circuit breaker and timeouts on every cross-module call, with metrics.

**Exit criteria**

- An end-to-end e2e test spanning both modules against Testcontainers passes.
- Duplicate delivery of the same event produces exactly one effect (inbox proven).
- Killing the relay mid-flight loses no event once it restarts.
- Trace context propagates through RabbitMQ headers: one trace, both services.

**Non-goals**

- No invoice document generation — `sales` emits an invoicing trigger and stops
  there; the document is `fiscal/`, roadmap.
- No financial posting — roadmap.

---

## Phase 8 — Golden path

The highest-priority deliverable in the repository. Once green, it stays green.

**Status: complete.** `make demo` owns migration, an idempotent tenant/user/catalog/stock
seed, the RabbitMQ order choreography, an HMAC-verifying callback receiver and a hard Jaeger
assertion for one trace containing Sales, Inventory and Webhooks. The always-on
`golden-path.yml` workflow runs it twice. The committed k6 run identifies 160 orders/s as
the local saturation point (80/s as the highest no-drop rate), records the optimization
made in response and retains its raw summary. The Jaeger capture near the top of the root
README reports three services and twelve spans.

**Deliverables**

- Seed script: a tenant with users, roles, products and stock.
- `make demo`: create sales order → reserve stock → confirm order → emit
  `sales.order.confirmed` → `webhooks` delivers a signed callback to a local
  receiver through its real RabbitMQ consumer, database and delivery worker.
- A CI job running the full flow on every push.
- k6 load test against the flow, results committed to `docs/benchmarks/`:
  throughput, p95, the saturation point, and what was changed in response.
- Jaeger screenshot of the single cross-service trace in `docs/assets/`, referenced
  near the top of the root README.

**Exit criteria**

- `make demo` succeeds from a cold `make up` with no manual step.
- The flow is **one** trace in Jaeger crossing three services and RabbitMQ.
- The CI job fails if the flow breaks, so the screenshot cannot become a lie.
- `docs/benchmarks/` contains measured numbers with the methodology stated.

**Non-goals**

- No UI in the flow — it is API-level.
- No production-scale tuning; the benchmark reports where it saturated, it does not
  promise a number.

---

## Phase 9 — Webhooks

**Status: complete.** The module exposes tenant-scoped subscription and delivery APIs,
encrypts signing secrets at rest, consumes the versioned confirmed-order contract and
persists an idempotent delivery per matching subscription. Its bounded worker signs the
exact body, records every attempt append-only, retries with exponential backoff and jitter,
and moves exhausted work to a replayable durable dead-letter state. `make demo` and the
committed load envelope both exercise this real path.

**Deliverables**

- Developer-facing subscription management, scoped per tenant.
- HMAC-signed delivery with a timestamped signature and a documented verification
  recipe.
- Retry with exponential backoff and jitter, bounded attempts, DLQ, replay endpoint,
  delivery logs.

**Exit criteria**

- A tampered payload fails signature verification in test.
- A permanently failing endpoint lands in the DLQ after the declared attempts and is
  replayable.
- Backpressure policy documented and exercised: queue growth past threshold has a
  defined behaviour, not an implicit one.
- Phase 8's golden path re-run end to end, now terminating at a real signed callback.

**Non-goals**

- No customer-facing dashboard yet (Phase 10).

---

## Phase 10 — Web — **complete**

**Status: complete.** The browser surface uses an HttpOnly BFF session and an allowlisted
Kong proxy. Catalog, customers, quotes, stock, orders, webhook subscriptions, workspace
access and API keys are live views over their own services; no service is addressed
directly. Authentication is account-first: workspace selection and subsequent switching
happen after login. `make test-phase10` exercises every screen in system Chromium,
verifies the 390 px responsive baseline, and requires Jaeger to show `web`, `gateway`,
`sales`, `inventory` and `webhooks` in the same trace.

**Deliverables**

- Next.js App Router app consuming the API **through Kong**, never directly.
- Authentication flow against `identity/`, session handling, post-login workspace
  selection and workspace switching.
- Operational surface for Catalog, Customers, Quotes, Inventory, Orders, Webhooks,
  workspace access and scoped API-key lifecycle management.
- Inter typography, Phosphor icons, Radix Colors tokens and accessible Base UI
  primitives shared across forms, dialogs, tabs, selects and destructive confirmations.
- OpenTelemetry in the frontend, traces joined to the backend trace.

**Exit criteria**

- A human can complete the golden path through the UI.
- A browser action produces a trace that joins the backend spans.
- Accessible and responsive to a stated baseline.

**Non-goals**

- No design system beyond what the screens need.
- No offline support, no mobile app.

---

## Phase 11 — Live deployment

**Current increment.** Package the smallest honest public deployment, document which
containers it includes, and keep platform secrets outside the repository.

**Progress.** `web/` now has a Vercel configuration and an opt-in hosted profile backed
by Neon's serverless driver. Its signed HttpOnly session and seeded Catalog path are kept
separate from the full local BFF. Provisioning and the topology disclosure live in
`docs/deployments/vercel-neon.md`; the remaining gate is an account-linked production URL.

**Deliverables**

- `web/` plus a minimal backend deployed to a free tier (Vercel / Fly.io / Railway,
  with Neon or Supabase for Postgres).
- The URL in the root README.
- A note stating plainly which parts of the architecture are and are not running at
  that URL.

**Exit criteria**

- The URL is reachable and demonstrates a real request path, with seeded demo data
  and a documented demo login.
- Secrets are held by the platform, never in the repository.

**Non-goals**

- Not the AWS stack. Not an SLA. Not a production deployment.

---

## Phase 12 — MCP debugger

Deliberately late: it has no value until logs, traces and metrics actually flow.

**Complete.** The standalone server exposes all ten tools over stdio and authenticated
streamable HTTP, with per-caller/tool limits, byte/row caps, tenant hashing, PII masking
and JSON invocation auditing. `make test-phase12` installs the NOLOGIN-owned wrappers
idempotently and proves over an authenticated PostgreSQL connection that the debug role
cannot read or write a business table or route unsafe SQL through `explain_query`.
The RabbitMQ tool deliberately reports non-mutating DLQ metadata only: the management
API's message-sampling operation performs dequeue/requeue and is incompatible with ADR
0035; this limitation is explicit in the tool result and debugger README.

**Deliverables**

- `tooling/mcp-debugger/` with stdio and streamable-HTTP transports, bearer auth,
  bound to localhost by default, behind `HORIZON_MCP_DEBUGGER_ENABLED` (default
  `false`).
- The ten read-only tools of §9.
- A dedicated Postgres role with the minimum privileges those tools need, and the
  `SECURITY DEFINER` wrapper that makes `explain_query` and `describe_schema`
  possible without granting table access (see ADR 0035).
- Tenant-identifier hashing and PII masking before any payload leaves the server;
  per-tool rate limits and result-size caps; full invocation logging.

**Exit criteria**

- Horizon runs fully with the debugger disabled and no Anthropic API key present.
- A test proves every tool is read-only: the debug role's attempts to write, execute
  arbitrary SQL, or read a business table all fail.
- `explain_query` rejects anything that is not a single `SELECT`, at parse time,
  before the driver.
- `tooling/mcp-debugger/README.md` states the design argument, not just the usage.

**Non-goals**

- No remediation actions. No restarts, no replays, no writes.
- No customer-facing agent — that is `tooling/mcp-agent/`, roadmap.

---

## Phase 13 — Terraform and release workflows

**Complete, and deliberately unapplied.** A single shared root composes the eight
modules below for both variable sets. Terraform 1.16.2 with AWS provider 6.x passes
`fmt`, `validate`, and provider-mocked plans for both `dev` and `prod`. Remote S3 state
and DynamoDB locking are partial configuration with placeholder resources and have
never been initialized. The manual release workflow can build immutable ECR images and
render a speculative plan only; `scripts/assert-no-terraform-apply.mjs` keeps an apply
command out of every workflow. The cost and bootstrap boundaries are stated in
`infra/terraform/README.md`.

**Deliverables**

- `infra/terraform/modules/`: `network`, `ecs-service`, `rds`, `elasticache`, `mq`,
  `alb`, `ecr`, `observability`.
- `infra/terraform/envs/dev` and `envs/prod`, differing only in variables.
- Remote state backend defined (S3 + DynamoDB lock), not initialized.
- Release workflows that exist with credentials absent.
- `infra/terraform/README.md` stating plainly that this has never been applied, with
  an estimated monthly cost if it were.

**Exit criteria**

- `terraform fmt -check` and `terraform validate` pass in CI.
- No `apply` exists in any workflow, and a CI check asserts that.

**Non-goals**

- Nothing is applied. No AWS account is involved.

---

## Phase 14 — Routed shell and bilingual frontend

**Complete.** The first slice of the
[operational ERP expansion plan](erp-expansion-plan.md) (phase A). The authenticated
product moved from one 1,200-line client component holding a nine-value `view` union to
nested App Router segments behind a shared shell, and every user-visible string now comes
from a message catalogue. Decisions 0040–0047 were recorded before the code that assumes
them.

**Deliverables**

- Route segments under `/app` for every screen, a shared layout owning the sidebar,
  topbar, session and notice region, and per-screen loading and error surfaces.
- `web/src/lib/navigation.ts`: a registry carrying route, message key, icon and the
  module role a user must hold. Visibility only; each service still enforces the role,
  and a route reached by URL renders a permission-denied state (ADR 0045).
- Developers area — API keys, webhooks and delivery logs — moved out of Settings and
  Operations; workspace settings separated from credentials.
- A shared frontend layer: a typed fetch client with session-expiry handling, a loader
  hook with one loading and error surface, and shared badge, heading, empty-state, money,
  quantity and date helpers that five feature views each had their own copy of.
- `next-intl` with key-identical `messages/pt-BR.json` and `messages/en.json`, locale
  resolved from the reader's stored choice, then the browser, then `pt-BR`, and a
  user-menu switcher that changes language without leaving the current resource
  (ADR 0044).
- `scripts/check-ui-copy.mjs`, wired into `npm run lint`, failing on any user-visible
  string written inline in a component.

**Exit criteria**

- Login, workspace selection and every ERP screen read correctly in both locales, and a
  catalogue test fails on a missing key, an empty translation or a placeholder that does
  not survive translation.
- The browser golden path negotiates Portuguese from the browser, switches to English
  mid-session, completes through the new routes, and still produces one joined trace.

**Non-goals**

- The signed-in user's stored locale preference and the workspace's legal country,
  timezone and base currency; both belong to phase B of the expansion plan.

---

## Phase 15 — Shared registrations and company configuration

**Complete.** Backlog items 5 and 6 of the [expansion plan](erp-expansion-plan.md). The
reader's language is stored on the global account and outranks this device's cookie; a
workspace describes the company it legally is. The `parties/` context owns every
organization and person the business deals with, and Sales' customers became a
projection of it (ADR 0040).

**Deliverables**

- Identity: `PATCH /identity/me/preferences`, `GET /identity/workspace` and an owner-only
  `PUT /identity/workspace/company` with legal name, registrations, address, base
  currency, fiscal regime and timezone.
- `parties/` on port 3006: one record per tax identifier, holding any of `customer`,
  `supplier`, `carrier`, `prospect` and `partner`; personal data encrypted per party with a
  blind-indexed tax identifier; crypto-shredding erasure; forced RLS; transactional outbox.
- `@horizon/contracts@0.4.0`: the `parties` module and roles, and five party events. Every
  service moved to it in the same change, because a token naming an unknown module is
  rejected.
- Sales consumes `parties.party.registered`, `updated` and `erased` into its customer
  projection and no longer registers or erases customers itself.
- `make migrate-customers`: registers every legacy Sales customer as a party adopting its
  identifier, so existing quotes and orders keep resolving. Idempotent.
- Web: the Customers screen reads and writes the registry; a Parties screen manages roles;
  the Workspace screen edits the company profile.

**Exit criteria**

- One party is both customer and supplier without a second tax-identifier record, and the
  same tax identifier may exist once in each tenant (integration tests).
- A registered party reaches Sales through the outbox and the inbox, under the id quotes
  and orders reference; erasure reaches Sales' copy.
- Both golden paths pass: `make demo` twice, and the bilingual browser flow including the
  Parties screen.

**Non-goals**

- Suppliers in Purchasing, contacts and multiple addresses per party, attachments and CSV
  import; these belong to later phases of the expansion plan.
- A `parties` role granted to existing workspaces automatically. Until administrators
  grant one, a Sales role keeps read and manage — never erase — on the registry.

---

## Phase 16 — Financial dimensions

**Complete.** Backlog item 7 of the [expansion plan](erp-expansion-plan.md). The
`financial/` context exists, and holds the dimensions every title will be classified by
before a single title exists (ADR 0041).

**Deliverables**

- `financial/` on port 3007: a revenue and expense category tree, departments and
  projects, payment methods and payment terms, each deactivated rather than deleted.
- Payment terms whose installment shares must total exactly 100% and whose due days never
  go backwards, with `POST /financial/payment-terms/:id/schedule` previewing the
  installments an amount produces on calendar dates.
- Allocation by percentage across departments and projects,
  `POST /financial/allocations/preview`, refused unless it totals exactly 100% across
  active dimensions of the same workspace.
- Money allocation that never loses or invents a minor unit (largest remainder), shares
  held as basis points and dates as calendar dates (ADR 0010, ADR 0043).
- `@horizon/contracts@0.5.0` declaring the `financial` module, with every service moved to
  it before any role in it could be granted.
- Web: Administration → Classifications, readable by every financial role and editable by
  a financial admin.

**Exit criteria**

- A thousand random splits add up to their totals exactly, and each part is within one
  minor unit of its exact share (property test).
- A child category cannot change nature, a tree stops at four levels, codes are unique per
  workspace and a parent from another workspace is refused (integration tests).
- A token carrying a financial role is accepted by Identity and Catalog; both golden paths
  pass, including Classifications at 390px.

**Non-goals**

- Sellers and buyers, which are people and belong with Identity or Parties rather than with
  money; import of categories from CSV; a starter chart of categories.
- Events for these registries. Nothing consumes them yet, so none are published.

---

## Phase 17 — Accounts receivable

**Complete.** Backlog item 8 of the [expansion plan](erp-expansion-plan.md), the receivable
half of its Phase C. A confirmed sales order becomes money someone collects, and every
correction stays in the record (ADR 0041, ADR 0042).

**Deliverables**

- One title kernel for both directions: installments, issue, competence and due dates,
  category, allocations and an origin. Drafts are revised or cancelled; posted titles are
  settled or reversed, never edited.
- Partial and full settlement with discount, interest and penalty, and settlement reversal
  with a reason. The balance of every installment is derived from the settlements in force.
- `Idempotency-Key` required on drafting, posting, settling and every reversal, stored in
  the same transaction as the effect, so a retry replays the first response and a reused
  key with a different request is refused (ADR 0028).
- A per-tenant hash-chained audit log, read back as each title's timeline (ADR 0025).
- Financial consumes `parties.party.*` into a projection and `sales.order.confirmed` into a
  draft receivable, once per order; a cancelled order withdraws its draft.
- `@horizon/contracts@0.6.0`: `financial.receivable.posted`, `financial.receivable.reversed`,
  `financial.settlement.recorded` and `financial.settlement.reversed`, relayed through the
  outbox and consumed by Webhooks.
- Receivable list with views, search, aging buckets and totals at the reader's calendar
  date, plus a detail with installments, settlements and history.
- Web: Finance → Accounts receivable, where an operator drafts, classifies, posts and settles
  and an admin reverses.
- `make demo` collects the order it places; the browser golden path classifies, posts and
  settles the receivable raised from the order it places.

**Exit criteria**

- Across random settlement and reversal histories, the outstanding balance equals the
  original amount plus interest and penalties minus receipts and discounts, and no
  installment goes below zero (property test).
- The application role cannot update or delete a settlement, remove a posted schedule or
  rewrite the audit log; the chain verifies link by link (integration tests).
- Aging buckets add up to the outstanding balance the list and detail show.
- Replaying a confirmation raises no second receivable; concurrent retries with one key
  produce one title.

**Non-goals**

- Accounts payable and approvals (backlog item 9), which reuse this kernel.
- Recurrence, bulk actions, attachments, forecasts, fees, credits and refunds.
- Backfilling parties registered before Financial consumed the registry. A party appears in
  Financial when it is next registered or described; the demo describes its customer again.

---

## Phase 18 — Accounts payable and approvals

**Complete.** Backlog item 9 of the [expansion plan](erp-expansion-plan.md), completing the
subledger half of its Phase C on the same title kernel as receivables (ADR 0041, ADR 0042).

**Deliverables**

- The title commands are shared by both directions: a payable is drafted, posted, settled
  and reversed exactly as a receivable is, names a supplier and an expense category, and a
  title of one direction is not found through the other's routes.
- Payable approval with four eyes: an operator requests it, a financial admin other than
  the requester approves or rejects it with a reason, and a revision withdraws any
  approval already given.
- A per-workspace approval policy per currency: payables at or above the threshold need
  approval, smaller ones post directly and are recorded as exempt. With no policy every
  payable needs approval.
- The database enforces what the aggregate does: a posted payable was approved or exempt,
  and the approver is never the requester.
- `@horizon/contracts@0.7.0`: `financial.payable.posted` and `financial.payable.reversed`,
  with the same payloads as their receivable counterparts.
- A payables list with an "awaiting approval" view and count, and a detail with the
  approval section and history.
- Web: Finance → Payables beside Receivables, sharing one set of components; an admin
  edits the approval policy there.
- The browser golden path grants the demo party the supplier role, drafts a payable,
  requests approval and checks the requester is not offered their own approval.

**Exit criteria**

- A payable that needs approval cannot post before it is approved, a requester cannot
  decide their own request, and a revision returns an approved draft to unapproved (domain
  and integration tests).
- A payable below the threshold posts as exempt; one at the threshold does not.
- Updating a row directly to a posted, unapproved payable or to a self-approval is refused
  by the database.
- Receivables keep passing every phase 17 test after the kernel was generalized, and
  `make demo` still settles the order's receivable.
- The migration applies over existing posted receivables, which it records as exempt.

**Non-goals**

- Multi-level approval chains, delegation and approval by amount band per role.
- A separate approver role; approval authority is `financial:admin` (decision 7 of the
  expansion plan keeps it inside the module).
- Purchase orders raising payables, which arrive with `procurement/` (Phase G).

---

## Phase 19 — Treasury accounts, balances and transfers

**Complete.** Backlog item 10 of the [expansion plan](erp-expansion-plan.md), its Phase D:
the `treasury/` context exists and knows where the company's money is according to its own
books (ADR 0041, ADR 0042).

**Deliverables**

- `treasury/` on port 3008, wired through `scripts/modules.json`, the Makefile, compose,
  Kong, the Postgres init script, CI, the web proxy and the demo.
- Bank, cash, card-clearing and virtual accounts with bank code, branch and account
  number, one currency, a tracked-from date and an active state.
- An append-only journal: direction instead of sign, value date, source (opening, manual,
  transfer, transfer fee, reversal), counterparty and memo, and a reconciliation state that
  stays unreconciled until Phase E. Manual entries are corrected by reversal, once.
- Transfers as one aggregate whose outflow, inflow and optional fee legs are written in the
  same transaction; cancelling appends inverse entries and keeps the originals.
- Book, projected and reconciled balances computed from the journal by value date, with the
  date they are as of; an account statement with the running balance after every line and a
  daily balance timeline. The statement balance field stays empty until statements exist.
- `@horizon/contracts@0.8.0` declaring the `treasury` module and its roles, with every
  service moved to it, and `treasury.account.opened`, `treasury.entry.recorded`,
  `treasury.transfer.posted` and `treasury.transfer.cancelled`.
- Idempotency keys on every money-moving command and a per-tenant hash-chained audit log.
- Web: Finance → Accounts and balances, with account cards labelled as ERP book balances, a
  statement with running balances, manual entries and reversals, transfers and their
  cancellation.

**Exit criteria**

- A transfer cannot commit with only one leg: a deferred constraint refuses it even when a
  row is written directly (integration test).
- The book balance and the daily timeline are the sum of the journal whatever order
  backdated entries are recorded in (property test); statements shift every later running
  balance when an earlier-dated entry arrives.
- Twenty concurrent transfers in both directions between two accounts keep the combined
  balance equal to the opening total minus fees, without deadlock.
- The application role cannot update or delete a journal entry.
- The browser golden path posts a transfer with a fee and checks that the combined book
  balance moved by exactly the fee.

**Non-goals**

- Statement import, bank balances and reconciliation (Phase E).
- Settlements in `financial/` creating treasury entries automatically (Phase F).
- Overdraft limits, available balance and bank integrations.

---

## Phase 20 — Bank statements and reconciliation

**Complete.** Backlog item 11 of the [expansion plan](erp-expansion-plan.md), its Phase E:
Treasury confronts the bank's record with the books', and a person decides (ADR 0046).

**Deliverables**

- Pluggable statement adapters behind a port, starting with OFX 1.x/2.x and CSV (Portuguese
  or English headers, `;` or `,`, decimal comma or dot). A bank-feed port with the same
  normalized output is declared for Open Finance providers, none implemented.
- Immutable imports: the file hash makes a reimport a reported no-op, and every line's
  fingerprint — the bank reference when there is one, otherwise date, amount, description
  and its occurrence within the file — skips lines already known from overlapping files.
  The bank's reference, document number, description and raw fields are kept.
- Reconciliations of one line to one entry, one to many and many to one, partial amounts,
  ignored lines with a reason, and an explicit adjustment entry for a difference the person
  accepts. Every reconciliation balances and is undone rather than deleted.
- Deterministic suggestions from amount, a five-day date window, document number,
  counterparty and description similarity, each with a score and its reasons. None is ever
  confirmed without a person; a dismissed suggestion is not proposed again.
- Acceptance, correction and dismissal counts per account, the evidence ADR 0046 asks for.
- Period closure through a date, refused while bank lines up to it are open; it freezes the
  reconciliations it covers until reopened with a reason.
- Accounts now report the reconciled balance and the last statement balance with its date.
- `@horizon/contracts@0.9.0`: `treasury.statement.imported`,
  `treasury.reconciliation.confirmed` and `treasury.reconciliation.undone`.
- Web: Finance → Bank reconciliation, with statement import, suggestions and their reasons,
  bank and book panes with the selected difference always visible, match, match with
  adjustment, ignore, history with undo, and period close and reopen.

**Exit criteria**

- Importing the same file again stores nothing, and an overlapping file stores only its new
  lines (integration test and browser golden path).
- Statement lines, imports and reconciliation items cannot be updated or deleted by the
  application role; an unbalanced reconciliation written directly is refused at commit.
- A reconciliation is undone with a reason, its lines become unmatched again, and a closed
  period refuses the undo until reopened.
- For a period, book opening + bank lines − ignored − unmatched bank lines + unmatched book
  entries + cross-period matches equals the book closing balance.
- Suggestions come out identical whatever order lines and entries arrive in, and never reuse
  a line or entry.

**Non-goals**

- Automatic confirmation above a confidence threshold, until measured acceptance supports
  its own ADR.
- Open Finance and bank-feed providers, CNAB return files and statement balances per day.
- Settlements in `financial/` recorded in Treasury automatically (Phase F).

---

## Phase 21 — Order to bank reconciliation, end to end

**Complete.** Backlog item 12 of the [expansion plan](erp-expansion-plan.md), closing its
first backlog: the golden path now follows one sale from the order to the bank line that
proves the money arrived, in one trace, with the amounts asserted at every step.

**Deliverables**

- A settlement may name the treasury account the cash moved through.
  `financial.settlement.recorded` carries it as an optional `treasuryAccountId`
  (`@horizon/contracts@0.10.0`, additive), and `treasury.entry.recorded` gains the
  `settlement` source.
- Treasury consumes `financial.settlement.recorded` and `financial.settlement.reversed`
  through its inbox: a settlement becomes exactly one journal entry in that account and a
  reversal reverses it. A settlement the account cannot take is recorded as refused with its
  reason rather than retried forever, and a settlement entry cannot be reversed by hand.
- `make demo`, which CI runs twice: the confirmed order raises a receivable, which is
  classified, posted and settled into a demo bank account; Treasury records the cash; a CSV
  statement line for it is imported; the matcher's suggestion for that exact pair is
  accepted, never auto-confirmed.
- The golden-path trace must contain `sales`, `inventory`, `webhooks`, `financial` and
  `treasury`.
- Web: the settlement form offers the treasury accounts the session may use.

**Exit criteria**

- The order total, the receivable total, the treasury entry, the statement line and the
  reconciled amount are asserted equal in CI, and the bank line ends matched.
- Redelivering a settlement event, or delivering it under another event id, records one
  entry; reversing it in Financial reverses that entry once (integration tests).
- Both golden paths pass twice in a row against a rebuilt platform.

**Non-goals**

- Ledger postings for these facts (Phase F).
- Choosing the account automatically from the payment method, and settlements imported from
  bank return files.

---

## Phase 22 — The general ledger: chart, journal, periods and trial balance

**Complete.** The first slice of Phase F of the [expansion plan](erp-expansion-plan.md).
`financial/` knows what is owed and `treasury/` knows where the cash is; neither knows what
any of it means in accounting terms. This is the module that does, and it is delivered
before the automatic postings that will feed it, so those have a book to post into that is
already proven balanced.

**Deliverables**

- `ledger/` (port 3009, Kong `/ledger`), a service with its own database, container and
  lifecycle, registered in `scripts/modules.json`, the Makefile, compose, the gateway and
  every workflow.
- **Chart of accounts** — asset, liability, equity, revenue and expense accounts in a tree
  whose shape is the dotted code itself. Only a leaf is postable; a parent totals its
  children and takes no lines. The domain refuses a misplaced account and a database
  trigger refuses one written around the domain.
- **Balanced journal** — a transaction is one currency, at least two lines and debits equal
  to credits, checked in the aggregate and again by a deferred database constraint. Lines
  are append-only under both the application role and the owner.
- **Reversal by mirror** — a correction swaps every side and leaves every account where it
  was (ADR 0042). A transaction is reversed once, a mirror is never reversed, and a mirror
  may be dated into a later month when the original's month is already reported.
- **Accounting periods** — calendar months derived from the posting date. Closing refuses
  postings into the month and reversals inside it; reopening keeps who and why. A month
  nobody closed has no record at all.
- **Reports** — the chart with per-account balances and subtree roll-ups, the trial balance
  (opening, movement, closing, and the two totals it exists to compare) and one account's
  lines with the balance each left behind.
- `@horizon/contracts@0.11.0`: `ledger.account.opened`, `ledger.transaction.posted`,
  `ledger.transaction.reversed`, `ledger.period.closed` and `ledger.period.reopened`, plus
  the `ledger` module with roles admin, accountant and viewer. Every service moved to it.

**Exit criteria**

- Every journal transaction balances to zero in its currency: asserted in the aggregate, in
  a property test across random postings and reversals, and by a deferred constraint that
  refuses an unbalanced transaction written directly (integration test).
- The trial balance's debit and credit totals are equal after any sequence of postings and
  reversals.
- A closed month refuses a posting and a reversal until it is reopened with a reason, and a
  later month is untouched by it.
- A posted transaction cannot be edited or deleted, and a line cannot be updated, by the
  application role or the owner.
- One workspace's chart, journal and reports are invisible to another (cross-tenant test).

**Non-goals**

- Postings raised automatically from `financial/` and `treasury/` events, and the forecast
  receivables and payables that sales and purchasing will raise (the next slice of Phase F).
- Multi-currency translation inside one transaction; a transaction is expressed in one
  currency, and translation is a later, separate decision.
- Cash flow, DRE and the drill-down reports Phase F closes with.
- A ledger screen in the web application, which arrives with the postings that make one
  worth opening.

---

## Phase 23 — Automatic postings: financial and treasury facts become journal transactions

**Complete.** The second slice of Phase F of the [expansion plan](erp-expansion-plan.md).
Phase 22 delivered a book proven balanced; this fills it without anyone typing an entry.

**Deliverables**

- **Posting rules as code.** A receivable, a payable, a settlement, an internal transfer
  and the treasury entries no other fact covers each have one rule, in one file. They are
  not configurable: a posting rule is accounting policy, and a rule engine a workspace can
  edit is a ledger nobody can audit.
- **Account mappings.** What a workspace does choose is which of its accounts plays each of
  twelve parts — receivables, payables, cash, revenue, expense, discounts, financial income
  and expense, bank fees, opening balance and suspense. Cash, revenue and expense are chosen
  per treasury account and per financial category; the rest once. A mapping must point at a
  postable account of the type the part requires.
- **Resolution with a fallback.** Exact, then the part's default, then suspense. Suspense
  keeps the books complete when a category has no account yet: the transaction balances and
  the accountant reclassifies it, rather than the fact being lost.
- **Pending facts.** A fact the workspace cannot post yet — nothing mapped at all, or a
  closed month — is kept with the numbers it arrived with and replayed once the workspace
  fixes it. A queue that retries an unmapped category forever is a queue that stops.
- **Idempotency by fact, not by event.** A posting is keyed by the settlement id or transfer
  id, so a redelivery under a new event id resolves to the same transaction; a database
  trigger refuses to repoint a fact at a second one.
- `@horizon/contracts@0.12.0`: `ledger.transaction.posted` gains the fact kinds as source
  types, and `financial.settlement.recorded` gains an optional `documentNumber`, so a
  consumer names the invoice a payment settles without holding the title.
- `make demo`, which CI runs twice: the demo seeds a chart and its mappings, and the sale's
  receivable and settlement are asserted as the exact journal lines they produced.

**Exit criteria**

- Replaying every event into an empty ledger produces the same balances, in any order and
  however many times each event is delivered (integration test).
- Every posting balances, for every combination of cash, discount, interest and penalty a
  settlement can carry (property test), including one that charges more than it collects and
  so raises what the party owes.
- A transfer moves cash without touching profit or loss; its fee does.
- A treasury line already accounted for by the fact that caused it is never posted twice.
- A fact reversed while still pending is never posted at all.
- The golden path's order, receivable, settlement, bank line and journal lines are asserted
  equal in CI, and no fact is left pending.

**Non-goals**

- Sales and purchasing forecasts: an approved order raising a forecast receivable that
  invoicing then replaces (the next slice of Phase F).
- Cash flow, DRE and drill-down reports, which close Phase F.
- A ledger screen in the web application, which follows the reports it would show.
- Posting rules a workspace can write, and multi-currency translation.

---

## Phase 24 — Forecasts: a confirmed order is money expected, invoicing makes it owed

**Complete.** The third slice of Phase F of the [expansion plan](erp-expansion-plan.md), and
the last of Phase C's deferred scope.

Until now a confirmed sales order became a draft receivable, which read as a claim on a
customer who had not been billed. It is now a forecast, and invoicing turns it into the
claim.

**Deliverables**

- **A stage on every title**: `forecast` or `effective`. A forecast never posts, so it never
  counts as a receivable or a payable and never reaches the ledger, and it appears in no
  view but its own — `all` included, because that list is what everyone reads as "the
  receivables".
- **Realisation in place.** Invoicing changes the stage of the same title rather than
  closing it and raising a second one, which is what makes duplication impossible rather
  than merely unlikely. When the invoice differs from the order, its total replaces the
  forecast's.
- **Either order.** Sales emits the confirmation and the invoicing request from the same
  operation, so they race through the queue. Whichever arrives first raises the title — the
  confirmation as a forecast, invoicing as effective — and the other finds it already there.
- **Expected money reported apart**: the summary counts forecasts and totals them per
  currency beside what is owed, never inside it.
- A title may also be drafted as a forecast by hand, and realised by hand when the invoice
  will not come. Procurement will raise payable forecasts the same way in Phase G.
- Web: a Forecasts view, an Expected card, and the action that realises one.

**Exit criteria**

- A confirmed order raises exactly one forecast, and invoicing leaves exactly one effective
  title — in either delivery order, and however often either event is redelivered
  (integration tests).
- A forecast cannot be posted, and what it expects appears in no view, summary or ledger
  posting that reports what is owed.
- The browser golden path asserts that nothing is expected once the order is invoiced, which
  is the duplication the design exists to prevent.
- Everything that existed before the column is effective, so no history became a forecast.

**Non-goals**

- Payable forecasts raised from purchasing, which arrive with `procurement/` in Phase G.
- Partial invoicing: one order raises one title, and an invoice for part of an order is a
  fiscal concern (Phase J).
- Rescheduling a forecast from the invoice: an invoice that differs replaces the total of a
  single-installment forecast, and a schedule a person built is theirs to change.
- Cash flow, DRE and drill-down reports, which close Phase F.

---

## Phase 25 — The reports the books exist to produce, and the way back to the facts

**Complete.** The last slice of Phase F of the [expansion plan](erp-expansion-plan.md), and
the phase's close. It is also the first screen `ledger/` has ever had: a headless set of
books is a set of books nobody can check.

**Deliverables**

- **Result of a period**, by account. Revenue and expense both read positive — an account
  moving the way its type expects is not a negative number — and a group shows what
  everything under it adds up to while only the leaves are totalled, so nothing is counted
  twice.
- **Realised cash flow**, by day, week or month, over the accounts the workspace mapped to
  the `cash` part of its postings. What counts as cash is not guessed from account names,
  so a report and a posting can never disagree about it. Every bucket in the range is
  present, including the empty ones.
- **Expected cash flow**, from `financial/`: what is still due, by the date it falls due,
  with what a posted title says is owed reported apart from what a forecast merely expects.
  What fell due before the range and is still unpaid is reported too, rather than dropped.
- **Drill-down**. Every ledger line names the fact it accounts for, so a figure in a report
  leads to the account, the account to its lines, and each line back out to the receivable,
  the settlement or the transfer behind it.
- **Web**: Finance → The books, with the result, cash flow expected beside realised, the
  trial balance, the chart, and the drill-down dialog. A banner when facts are still
  pending, because a report is only as complete as what has been posted.

**Exit criteria**

- The reports reconcile with the facts they were built from: revenue equals what was
  invoiced, closing cash equals what was collected, and the receivables account holds
  exactly the difference (integration test).
- Two consecutive periods add up to the one that spans both, because every figure is the
  movement inside its range and never a balance carried into it.
- A transfer between two accounts that both map to one cash account nets to nothing; its
  fee does not.
- Every line of an account names the fact that put it there, asserted in the integration
  test and again in the browser golden path, which also asserts the trial balance balances.
- A workspace that has mapped no cash account gets an empty report rather than a wrong one.

**Non-goals**

- A `reporting/` module with its own store and scheduled extracts, which is Phase M.
- Charts: these are tables, and a chart is worth adding once someone has read the tables
  enough to know which shape they want.
- Budgets and variance, and comparison against a prior period.
- Multi-currency reporting: every report states one currency, because a transaction does.

---

## Phase 26 — Purchasing: a need, what suppliers would charge, and what the company committed to

**Complete.** The first slice of Phase G of the [expansion plan](erp-expansion-plan.md).
Everything Horizon has bought until now arrived in inventory without anyone having decided
to buy it. This is the module where that decision is made, and made visibly: who asked, who
agreed, what was offered, and what was committed.

**Deliverables**

- `procurement/` (port 3010, Kong `/procurement`), a service with its own database,
  container and lifecycle, registered in `scripts/modules.json`, the Makefile, compose, the
  gateway and every workflow.
- **Requisitions** — a request to buy, deliberately free of money. What it asserts is a
  need: this item, this quantity, by this date, for this warehouse. A need is approved on
  its merits and what it costs is discovered afterwards, which is what makes the approval of
  a need auditable separately from the approval of a commitment.
- **Quotations and their comparison** — what each supplier said it would charge, against
  the lines that were actually asked for. A quotation is never revised; a supplier that
  changes its mind sends another one and both stay. The comparison marks the cheapest unit
  price per line and deliberately passes no verdict on a quotation as a whole, because
  freight, lead time and payment terms are part of the decision and a person weighs them.
  Selecting one offer declines the rest in the same transaction.
- **Purchase orders** — the commitment, holding its own copy of everything: the supplier's
  name, each line's description and price, the tax, the freight, the payment terms. A draft
  is a working document; from approval onward the order is frozen and a change of mind is a
  cancellation, not an edit.
- **Approval thresholds** — the value per currency at or above which an order needs a second
  person. Below it the order is committed on the spot and records that nobody was asked, so
  an audit can tell an exemption from an oversight. A currency with no policy asks somebody
  about every order.
- **Four eyes on both documents** — whoever submitted a requisition cannot decide it, and
  whoever placed an order cannot approve it, in the aggregate and again as a database
  constraint. The role map keeps `buyer` and `approver` apart for the same reason.
- `@horizon/contracts@0.13.0`: seven `procurement.*` events and the `procurement` module
  with roles admin, buyer, approver and viewer. Every service moved to it before the role
  was granted anywhere.

**Exit criteria**

- A requisition is answered by at most one order: a second attempt is refused by the domain
  and by a partial unique index, and a rejected or cancelled order frees the requisition
  again (integration test).
- Repeating the request that creates a document creates one document, not two.
- An order at or above the threshold waits for somebody else; one below it is committed and
  records that nobody was asked.
- `procurement.order.approved` carries a dated payment schedule that adds up to the order
  total, validated against the published contract from the outbox row itself.
- The lines of a committed order cannot change under the application role or the owner.
- One workspace's requisitions, quotations and orders are invisible to another.

**Non-goals**

- Receiving: goods receipts, partial and over-receipt, returns and the inventory movement
  and payable they produce (the next slice of Phase G).
- Purchasing screens — the requisition and order boards, the approval inbox, the supplier
  comparison and the purchase history — which follow the receiving they would show.
- Purchase suggestions from min/max stock, which the expansion plan defers until inventory
  availability projections are trustworthy.
- Contracted prices and supplier catalogues: a quotation is priced by hand, because a price
  list per supplier is a registry of its own and nobody has needed one yet.

---

## Phase 27 — Receiving: the goods on the shelf and the money owed for them, from one fact

**Complete.** The second slice of Phase G of the [expansion plan](erp-expansion-plan.md),
and the payable forecasts Phase F left waiting.

A purchase order is a promise. This is the phase where the promise meets a loading bay: part
of it arrives, stock goes up, money becomes owed, and what has not arrived is still
expected — three statements that have to agree, and now do, because all three follow from
one event.

**Deliverables**

- **Deliveries, partial or complete.** What the goods make owed is their *share* of the
  order's total: tax, freight and the discount were agreed for the order as a whole, so a
  partial delivery carries them in proportion. The share is taken cumulatively and the
  earlier one subtracted, so rounding never accumulates and the last delivery of a complete
  order leaves nothing behind.
- **Over-receipt, deliberately.** More may arrive than was ordered, and sometimes that is
  fine — but never silently. It takes a reason, the reason is kept, and what is owed rises
  above the order total accordingly, because a delivery nobody agreed to is a cost nobody
  agreed to.
- **Returns.** A delivery sent back leaves stock again, its payable is withdrawn, and what
  the order still expects goes back up by the same amount: a rejected delivery is a delivery
  the supplier still owes. The receipt and the return both stay in the record (ADR 0042).
- **Closing.** An order that received everything, or that a person closes short with a
  reason, stops expecting anything more, and whatever was still committed lapses. An order
  that has taken delivery is closed rather than cancelled.
- **Stock, from the receipt.** `inventory/` brings each line in at the price the order
  agreed, and takes it back out on a return — refusing to, if somebody has already promised
  those goods to a customer.
- **Payables, from the same receipt.** An approved order raises a payable **forecast** for
  its whole value; each delivery raises an **effective** payable for what it carries and
  reduces the forecast to what is still committed. The two are never both counted, which is
  what the forecast stage has existed for since phase 24. A forecast withdrawn when the
  order completed is reinstated if a return brings the commitment back, rather than a second
  title being raised beside it.
- **One origin for every title.** `financial/` titles now name the document they came from —
  a sales order, a purchase order or a goods receipt — through one `documentId` instead of a
  column named after sales. The published `origin` carries it for every kind, and a sales
  order keeps its `orderId` alongside, because that field is published and cannot be
  withdrawn (ADR 0030).
- `@horizon/contracts@0.16.0`: `procurement.receipt.recorded`, `procurement.receipt.returned`
  and `procurement.order.closed`, each carrying its schedules already dated so no consumer
  has to know how payment terms were expressed.
- `make demo` runs the purchase: a need, a quotation, an approval by a second person, a
  partial delivery — and asserts that the stock, the payable and the forecast agree about
  exactly how much arrived, inside the same trace as the sale.

**Exit criteria**

- Requisition → approval → purchase order → partial receipt → inventory movement → payable
  runs in `make demo`, in one trace that names `procurement`, and CI runs it twice.
- A delivery moves stock once and raises one payable, however often its event is
  redelivered, and a retried receiving request receives the goods once.
- The values of every delivery against a complete order add up to the order total exactly,
  freight and tax included (domain property and integration test).
- What a delivery makes owed plus what the order still expects always equals the order
  total, and a forecast never appears in any view that reports what is owed.
- An over-receipt is refused until somebody says why; a return puts back what it took away,
  in the stock, in the payable and in the forecast.
- Goods cannot arrive against an order nobody committed to, under the application role or
  the owner.

**Non-goals**

- Purchasing screens — the requisition and order boards, the approval inbox, the supplier
  comparison and the receipt conference — which close Phase G.
- Partial returns: a delivery is returned whole, because a partial return of a partial
  delivery is a quantity puzzle nobody has asked for yet.
- Landed cost: stock enters at the price the order agreed for the line. Apportioning freight
  and tax into inventory valuation is a costing decision, and it belongs with the valuation
  work in Phase I.
- Supplier invoices and the three-way match against them, which arrive with fiscal documents
  in Phase J. Until then the receipt is what makes a payable.

---

## Phase 28 — The purchasing screens: what was asked for, what was committed, what arrived

**Complete.** The last slice of Phase G of the [expansion plan](erp-expansion-plan.md), and
the phase's close. Purchasing has been able to do everything since phase 27; this is where
somebody can see it.

**Deliverables**

- **Boards, not lists.** Requisitions and orders each appear in the columns work actually
  moves through, so "what needs doing" is a glance rather than a filter. A column that is
  empty says so instead of disappearing: a buyer reading *nothing waiting for approval* has
  learned something, and a board whose columns move about between visits cannot be read at
  a glance.
- **The approval inbox** — everything whose next step is a decision, and never the reader's
  own document. It is deliberately not a fourth kind of record: it is the same requisitions
  and orders, filtered, so deciding one there and finding it on its board afterwards is the
  same object rather than a copy of it.
- **The comparison** — every supplier's offer under the line it is for, read across a row
  rather than between two documents. The cheapest unit price per line is marked by the API,
  so the table and whoever reads the API agree about which it is, and choosing one offer
  declines the rest in the same transaction.
- **The conference** — each order line with what was ordered, what has come and what is
  still outstanding, and a field per line that starts at the outstanding quantity, because
  that is what a delivery usually is and a number somebody has to retype is a number
  somebody mistypes. Accepting more than was ordered needs the reason typed in beside it.
- **The history** — every delivery against the order, what it was worth, and what went back,
  with the reason in both cases.
- Bilingual copy in `en` and `pt-BR`, Base UI dialogs, and a role map that shows a buyer the
  actions a buyer has and an approver the ones an approver has — visibility only; the
  service still refuses what a role does not permit (ADR 0023, ADR 0045).

**Exit criteria**

- The browser golden path reaches the requisition the demo ordered, opens the order it
  became, and asserts the conference says eight units are still expected — the same figure
  the payable and the stock movement were derived from.
- The approval inbox offers nobody their own document, asserted in the browser.
- Every string is a message key in both locales, and the key-parity test covers them.

**Non-goals**

- Writing a requisition, recording a quotation or drafting an order by hand in the browser:
  the screens read and decide, and the documents are created through the API. The forms are
  worth building once somebody has used the boards enough to know what they need on them.
- A goods receipts screen of its own and a suppliers screen: a delivery is read on the order
  it arrived against, and a supplier is a party, in the registry that owns it.
- Drag and drop between columns. A column is a state a document reaches by being decided,
  not by being dragged, and a board that lets you drag would have to invent a decision.

---

## Phase 29 — The commercial document: an offer negotiated, and the order it becomes

**Complete.** The first slice of Phase H of the [expansion plan](erp-expansion-plan.md).

Until now a sale began with an order somebody had already decided on. Most sales do not
begin there: they begin with a price somebody asked for, an answer, a counter-offer, and a
yes. This is the phase where that conversation is a record rather than a memory — and where
the yes carries into the order, the stock and the money without anybody retyping it.

**Deliverables**

- **An offer negotiated in versions.** A quote that has been sent is never rewritten.
  Answering one produces a **new version** beside it, which supersedes the last and shares
  its identifier, so the record shows what was actually put in front of the customer and
  when, rather than only what was agreed in the end. A draft nobody has seen is simply
  corrected. Exactly one version of an offer is current at any moment — a partial unique
  index says so, not a convention.
- **A discount deep enough to matter is somebody else's decision.** The workspace allows a
  seller so many basis points against the goods; beyond that the offer waits, and **whoever
  asked cannot be the one who grants it** (four eyes, in the aggregate and in a table
  constraint). An allowance that was not exceeded is recorded as *not required*, so an audit
  can tell an exemption from an oversight.
- **What the offer says beyond the goods** — the seller, the discount, the freight, the
  carrier, the payment terms and the notes — carried onto the order it becomes. Payment
  terms are days from issue (`0/30/60`), because they are agreed before anybody knows which
  day the order will be issued on; the dates are derived once, when the receivable is
  raised.
- **Conversion.** An accepted quote becomes **at most one** order: the same lines, at the
  prices the customer agreed to, under the terms that were negotiated. The order is confirmed
  at those prices even if the catalogue has moved in between, because a price list that
  changed between the yes and the reservation is not a new agreement. A unique index makes
  the second conversion impossible rather than merely unlikely.
- **A receivable on the schedule that was agreed.** `sales.order.confirmed` now carries the
  instalments, already dated, and `financial/` raises the forecast on them instead of on a
  single payment it invented. A title cannot fall due before it is issued, so an order
  issued the day before it was confirmed is issued on the earlier of the two dates.
- **The audit log and the command receipts Sales never had.** Every decision on a quote and
  every order placed is a line in the tenant's hash-chained log, naming who took it; every
  command that creates a document takes an `Idempotency-Key` and is run at most once
  (ADR 0025, ADR 0028).
- `@horizon/contracts@0.17.0`: `sales.quote.sent`, `sales.quote.accepted`,
  `sales.quote.rejected`, and `installments` **optional** on `sales.order.confirmed` — so a
  consumer written before payment terms existed keeps parsing confirmations.

**Exit criteria**

- Quote → negotiation → acceptance → order → reservation → confirmation → receivable runs
  in `make demo`, and the receivable it raises has the instalments the quote agreed.
- A sent quote cannot be edited: the attempt is refused by the aggregate and, if it ever
  got past it, by a trigger on the lines.
- The person who asked for a discount cannot approve it, asserted in the domain and in the
  database.
- An accepted quote converts once; a retried conversion answers with the order it already
  made, and no second order exists.
- A converted order is confirmed at the quoted price after the catalogue price has changed.
- Every quote decision appears in the audit chain, in order, under the actor who took it.

**Non-goals**

- Fulfilment and returns — picking, packing, shipping, partial delivery and the customer
  return with its stock and financial reversal — which are the next slice of Phase H.
- The screens: quotes, the negotiation history and the approval queue are driven through
  the API here, and get a place to be seen in the slice that closes the phase.
- Commissions and profitability. The seller is on the document; what they earn from it waits
  for costs to be stable, which is Phase I.
- Re-pricing a quote when the catalogue moves. An offer is a price held open until it
  expires — that is what makes it an offer.

---

## Phase 30 — Getting the goods there: picking, partial delivery, and what comes back

**Complete.** The second slice of Phase H of the [expansion plan](erp-expansion-plan.md).

A sale used to end when the order was confirmed: the stock left the shelf at that moment,
the invoice was asked for at that moment, and the whole order was owed at that moment. Real
orders do not behave like that. They are picked, packed and sent — sometimes in parts,
sometimes late, sometimes back again. This is the phase where confirming an order and
delivering it stop being the same event.

**Deliverables**

- **The delivery is the fact.** Confirming an order now *holds* the stock; it is the
  dispatch that takes it out. The reservation finally means what its name says: between the
  commitment and the van, the goods are on the shelf and spoken for.
- **Picking, packing, dispatch.** A shipment exists before it leaves, because picking and
  packing take time and the warehouse needs somewhere to write down what it is doing.
  Picking *holds* the quantities against the order, so two boxes being prepared at once
  cannot promise the same unit. A box nobody closed cannot be sent, and one that never left
  can be abandoned — its goods go back to the order, to be promised again.
- **Partial delivery.** What a delivery makes owed is its **share** of the order's total,
  because freight and the discount were agreed for the order as a whole. The share is taken
  cumulatively and the earlier one subtracted, so rounding never accumulates and the
  delivery that completes an order leaves nothing behind — the same arithmetic the buying
  side has used since phase 27.
- **The money follows the goods.** A confirmed order raises a **forecast** receivable for
  the whole of it; each dispatch raises an **effective** receivable for what it carried and
  reduces the forecast to what has still to be delivered. The two are never both counted,
  which is what the forecast stage has existed for since phase 24. An invoice is asked for
  per delivery, because an invoice is written for what was actually shipped.
- **Customer returns.** A delivery that comes back puts the goods on the shelf at the cost
  they left at and *back into their promise* — the customer is still owed them, so they are
  held for the order rather than becoming free stock somebody else can be sold. What the
  delivery made owed is withdrawn, what the order still has to deliver goes back up, and
  both the dispatch and the return stay in the record (ADR 0042).
- `@horizon/contracts@0.18.0`: `sales.shipment.dispatched` and `sales.shipment.returned`,
  each carrying its schedules already dated; `return-in` as a stock movement kind; and
  `sales-shipment` as the origin a receivable can come from.
- `make demo` picks, packs and sends the order it sold, and only then collects the money —
  in the same trace, with the stock, the receivable and the books agreeing about what left.

**Exit criteria**

- Quote → order → reservation → dispatch → receivable runs in `make demo`, in one trace,
  and the money is not owed until the goods have gone.
- A partial delivery and the delivery that completes the order add up to the order total
  exactly, freight and discount included (domain property and integration test).
- What a delivery makes owed plus what the order still has to deliver always equals the
  order total, and a forecast never appears in any view that reports what is owed.
- The same unit is never promised to two deliveries, asserted in the aggregate and by a
  table constraint.
- A returned delivery puts back what it took away, in the stock, in the receivable and in
  the forecast, and the order owes those goods again.
- A delivery that has left cannot be edited: the attempt is refused by the aggregate and by
  a trigger on its lines.

**Non-goals**

- Sales screens — the shipment board, the picking list and the returns view — which close
  Phase H.
- Partial returns: a delivery goes back whole, exactly as on the buying side, because a
  partial return of a partial delivery is a quantity puzzle nobody has asked for yet.
- Closing an order short. An order that will never be delivered in full needs a person to
  say so, and what that should do to the hold and the forecast is a decision worth taking
  with the screens rather than before them.
- Carrier integrations. The carrier and the tracking code are what the warehouse typed;
  asking a carrier where the parcel is belongs with fiscal documents and logistics.
- Costing the return at anything other than what it left at. Valuation is Phase I.

---

## Phase 31 — The sales screens: the offer, the decision and the van

**Complete.** The last slice of Phase H of the [expansion plan](erp-expansion-plan.md), and
the phase's close. Selling has been able to do everything since phase 30; this is where
somebody can see it — and where the browser golden path stops being a shortcut, because the
money is now owed by a delivery somebody has to send.

**Deliverables**

- **One card per offer, not one per version.** A negotiation that went four rounds is one
  offer a customer is thinking about; a board that showed all four would report four times
  the work there is. The card is the newest version, and the rest is how it got there.
- **The negotiation, in the dialog.** Every version of the offer with its total, its
  discount and how it was left, because a price is only readable against the price it
  replaced. Somebody deciding whether to allow a discount is deciding about a movement, not
  about a number.
- **Answering an offer is the same form that made it**, filled with what is on the table. A
  revision is not a different kind of document: it is this offer said again, differently.
- **The approval queue** — offers held back by a discount over the allowance, and never the
  reader's own. As in purchasing, it is deliberately not a second kind of record: the same
  offers, filtered, so allowing one there and finding it on its board afterwards is the same
  document rather than a copy of it.
- **The deliveries board** — picking, packed, sent, came back — with the warehouse's own
  steps on it: take goods off the shelf, close the box, send it, record a return, or abandon
  a box that never left. Each picking field starts at what the order still owes, less what
  another box is already holding, so two boxes being prepared at once cannot promise the
  same unit.
- **The order says where it got to**: its fulfilment state on the list, and per line what has
  gone and what is still to go — the figures Sales derives, never arithmetic done again in
  the browser.
- The board and the document dialog are now shared with purchasing rather than copied from
  it: one `Board`, one set of `document-*` styles, two modules.
- Bilingual copy in `en` and `pt-BR` for every new string, with the key-parity test covering
  them, and `GET /shipments` in Sales, because a warehouse's work is not one order's.

**Exit criteria**

- The browser golden path negotiates an offer — created, sent, answered with a second
  version, accepted — and asserts both versions stay in the record.
- It then picks, packs and sends the order it placed, and only the delivery makes the money
  owed: the receivable it classifies, posts and settles is the delivery's `SH-…`, and no
  forecast is left behind.
- The approval queue offers nobody their own discount, asserted in the browser.
- Every screen holds at 390px with no horizontal overflow, the new ones included.

**Non-goals**

- A screen for the commissions and the profitability of a sale: the seller is on the
  document, but what they earn from it waits for costs to be stable (Phase I).
- Partial returns and closing an order short, which the aggregate does not offer yet and
  which phase 30 left as decisions worth taking with the screens rather than before them.
- Drag and drop between columns, for the same reason as in purchasing: a column is a state
  a document reaches by being decided, not by being dragged.
- Re-pricing an offer when the catalogue moves. An offer is a price held open until it
  expires — that is what makes it an offer.

---

## Phase 32 — Stock moved on purpose: a transfer, a write-off and a count

**Complete.** The first slice of Phase I of the [expansion plan](erp-expansion-plan.md).

Every movement Inventory has ever recorded was somebody else's decision. Stock arrived
because purchasing bought it and left because sales sold it, and the warehouse itself had
no way of saying anything at all — not that a pallet had been dropped, not that a box had
been moved to the other building, not that the shelf holds ninety-eight of something the
system is certain there are a hundred of. This is the phase where the warehouse can speak,
and where what it says is answerable to somebody.

**Deliverables**

- **A transfer moves goods, not value.** Both halves are written in one transaction, so
  there is no moment at which the stock is in neither place, and what leaves the source
  carries **its own cost** to the destination rather than being valued again there. Only
  *available* stock goes: what is reserved is spoken for by an order that expects to find
  it where it is. Goods may leave a warehouse that has been closed — that is how one is
  emptied — but nothing is put into one that has.
- **An adjustment answers to an allowance.** This is the one command in the module that can
  make the figures say whatever the person typing wants, so past a value the workspace sets
  the goods do not move until a second person allows it, and **that person is never the one
  who asked** (four eyes, in the aggregate and in a table constraint). A workspace that has
  set no allowance has every adjustment approved: silence about a control is not permission
  to skip it, which is also why the row cannot be deleted.
- **A reason that works in the direction asked for.** Stock is not *found* by taking it off
  the shelf and breakage puts none back; `correction` is the only reason that works both
  ways, because it is the one that admits the figure was simply wrong rather than claiming
  to know what happened.
- **An adjustment changes how many there are, never what one is worth.** Goods enter at the
  average the balance already carries, and a stated cost is accepted only when there is no
  average to use — an adjustment that re-prices stock is a receipt pretending not to be one.
- **A count posts the difference, not the figure.** The sheet freezes what the system
  expected when it opened, because that is what the counter is disagreeing with. If the
  shelf said a hundred, the counter found ninety-eight, and ten were shipped while they were
  counting, the balance ends at eighty-eight — writing ninety-eight over it would quietly
  undo a delivery that really happened. A line nobody counted is left alone, because not
  counting something is not the same as counting zero of it.
- **A count that writes off enough is a write-off.** Its differences are weighed against the
  same allowance, by the sum of their absolute values rather than their net, so a sheet that
  finds a hundred of one thing and loses a hundred of another cannot net itself through.
- **The audit log and the command receipts Inventory never had.** Every transfer, write-off,
  count and allowance is a line in the tenant's hash-chained log naming who took it; every
  command that moves stock takes an `Idempotency-Key` and is run at most once (ADR 0025,
  ADR 0028).
- `@horizon/contracts@0.19.0`: `transfer-in` and `transfer-out` movement kinds, and
  **optional** `reason` and `document` on `inventory.stock.moved` — so a producer written
  before stock could be transferred, adjusted or counted still emits a movement the schema
  accepts. The two halves of a transfer carry the same document, which is what pairs them
  for a reader.

**Exit criteria**

- A transfer leaves the company owning exactly what it owned before it: the value that left
  the source arrives at the destination, asserted in the domain and in the database.
- The same goods are never both reserved for an order and transferred or written off away
  from it, asserted in the aggregate.
- The person who asks for a write-off cannot allow it, refused by the aggregate and, if it
  ever got past that, by a table constraint.
- A count that runs while stock moves posts its difference against the balance as it then
  is, and the delivery that happened meanwhile survives it.
- A settled count takes no more figures: refused by the aggregate and by a trigger on its
  lines.
- Every decision appears in the audit chain, in order, under the actor who took it, and the
  chain cannot be rewritten.

**Non-goals**

- The screens. Transfers, the write-off queue and the count sheet are driven through the
  API here and get somewhere to be seen in the slice that closes Phase I.
- The Kardex, valuation reports, stock position, min/max alerts and the ABC curve. The
  movements now carry why they happened and under which document, which is what those
  reports will be built from — but building them is the next slice.
- Stock in transit. A transfer here is instantaneous, because a warehouse that is a
  lorry is a warehouse, and the module has no way to say where one is yet.
- Negative stock under a workspace policy. Nothing may drive a balance below zero, full
  stop; the override the expansion plan asks for waits until there is a reader who can see
  what it would have produced.
- Reversing a posted transfer or adjustment. Both are already in the append-only ledger the
  balances are derived from, so correcting one is another movement in the other direction —
  never an edit (ADR 0042).
- Partial counts of a warehouse being frozen while they run. The sheet deliberately does not
  stop the warehouse working, which is the whole reason it posts a difference rather than a
  figure.

---

## Phase 33 — The warehouse's own books: the Kardex, what it is worth, and what to do about it

**Complete.** The second slice of Phase I of the [expansion plan](erp-expansion-plan.md).

Inventory has always been able to say what it holds. It has never been able to say what it
held — not what was on the shelf last Tuesday, not what the shelf was worth then, not what
the goods that went out last month had cost to buy. The movement table had most of the
answer all along: every movement records the balance it left behind. What it never recorded
was what a unit was then worth, because a unit's worth is the balance's moving average and
no movement ever wrote it down. This is the phase where the ledger stops needing the balance
table to explain itself, and where the figures it can now produce are turned into the six
reports an operator actually asks for.

**Deliverables**

- **The column the movement table should always have carried.** Every movement now records
  the balance's unit cost *after* it was applied — not the price the goods moved at, which
  is a different figure, because goods arriving at 12.00 onto a shelf holding some at 10.00
  leave every unit worth something between the two, and goods leaving change no unit's
  worth at all. With it, the standing of any shelf on any past day is one row, not a replay
  of every receipt since the beginning. The history that predates the column is backfilled
  by replaying the same arithmetic the aggregate does, anchored where it must be: a shelf
  whose ledger opens with a shipment is anchored by that shipment, because goods leaving
  are priced at the very average they do not change.
- **A Kardex for one item on one shelf.** An opening standing, every movement in order with
  what it moved and where it left the balance, and a closing standing. Deliberately not
  offered for an item across every warehouse: the same thing in two buildings has two
  running balances and two costs, and interleaving them by the clock produces a column of
  figures that is true of nothing anybody can walk up to and count. A page in the middle of
  a long history is still exactly right, because the opening is read from the shelf's own
  record rather than summed from what came before it.
- **A valuation of any instant that has already passed**, read from the movements alone.
  Asked about now it returns exactly what the balance table holds, which is the whole claim
  the movement ledger makes and the one the tests check against the table the report never
  consults. A shelf that has been emptied is left out: nothing is not a holding.
- **A stock position that is paged and filtered**, beside the warehouse listing that
  embeds a few balances for convenience and stops being usable at the size where this is
  needed.
- **Minimum and maximum levels, and the alerts they raise.** A level is a target, never a
  control — nothing refuses a movement for crossing one — which is why setting one is not
  an approval decision and why there is no way to delete one: a minimum of zero says "do not
  tell me about this item" on the record, where the next person can see that somebody
  decided it. **Short is measured against what is free and over against what is physically
  there**: goods promised to an order cannot cover the next one, but they do take up the
  shelf they are sitting on. The report is driven from the levels rather than from the
  balances, so an item a warehouse is supposed to keep and currently has **none** of
  appears — the alert that matters most, and the one a query over balances would silently
  miss.
- **What the goods that were sold had cost**, valued at the average each shipment was
  priced at when it went and net of what came back at the cost it went out at. A transfer
  is not in it, because goods in the other building are still the company's; a write-off is
  not in it either, because losing stock costs money but is not the cost of selling
  anything, and an ERP that buries breakage inside its margin has hidden the one figure the
  warehouse most needs to see.
- **An ABC curve over the same consumption**, so the two can never disagree about what a
  period sold. An item belongs to the class its cumulative share *reaches*: the item that
  carries the running total past eighty per cent is the reason the total got there, and
  calling it a B because it finished at eighty-one would be exactly backwards. Drawn
  separately per currency, because a ranking that adds pesos to euros ranks nothing.
- No contracts change. Nothing here is announced to another module: the new figure is how
  this warehouse values what stayed, which is its own business, and every report is a read.

**Exit criteria**

- A valuation as of now equals the balance table, item for item and figure for figure,
  asserted against a table the report never reads.
- A valuation of a past day returns what that day left, not today's figures applied
  backwards.
- A Kardex window opens exactly where the previous window closed, so two pages read end to
  end tell the same story as one.
- The cost of goods sold counts what was sold and nothing else, with a transfer and a
  write-off in the same period to prove it.
- An item a warehouse keeps none of is raised as an alert, and a shelf whose stock is all
  promised away is short even while it is also over.
- One workspace's reports never contain another's rows.

**Non-goals**

- The screens. The Kardex, the position, the alerts and the curves are driven through the
  API here and get somewhere to be seen in the slice that closes Phase I.
- Posting the cost of goods sold into the ledger. The figure exists now; deciding when a
  period's cost is booked, and against which accounts, is an accounting decision that
  belongs with whoever owns the chart — not a side effect of a report being run.
- FIFO, LIFO or standard costing. The moving average is the method the module keeps, and
  offering a second one means keeping two sets of books that have to be reconciled.
- Lots, serial numbers and expiry, which are the next slice. A Kardex line is an item on a
  shelf here, and will gain a lot when there are lots to gain.
- Naming items. The reports return ids: the catalogue is another module's, and a report
  that joined across the boundary to be friendlier would be a module importing another
  module's data.
- Reordering from an alert. What to buy, and from whom, is purchasing's decision; the
  alert says a shelf needs attention, not who should be sent a purchase order.
- Restating history when the backfill cannot know it. A shelf whose ledger opens with a
  receipt onto stock that was already there is valued at nothing for that opening, and the
  balance table remains the authority on it until the next thing leaves. Guessing would
  have been worse than saying so.

---

## Standing rules across all phases

- The golden path (Phase 8) stays green from the moment it exists.
- A module never imports from another module's source tree.
- Every business table carries `tenant_id` with forced RLS, and every aggregate has
  a cross-tenant test.
- Coverage gates domain and application layers only, not infrastructure adapters.
- A folder appears when its phase begins, not before.
