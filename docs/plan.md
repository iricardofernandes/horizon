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

## Standing rules across all phases

- The golden path (Phase 8) stays green from the moment it exists.
- A module never imports from another module's source tree.
- Every business table carries `tenant_id` with forced RLS, and every aggregate has
  a cross-tenant test.
- Coverage gates domain and application layers only, not infrastructure adapters.
- A folder appears when its phase begins, not before.
