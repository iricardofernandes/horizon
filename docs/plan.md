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

## Phase 4 — Identity

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

## Phase 5 — Pattern extraction

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

## Phase 6 — Catalog

The simplest business module. It exists to prove the template is followable.

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

**Deliverables**

- Seed script: a tenant with users, roles, products and stock.
- `make demo`: create sales order → reserve stock → confirm order → emit
  `sales.order.confirmed` → `webhooks` delivers a signed callback to a local
  receiver. (Ordering note: `webhooks` is Phase 9; until then the demo terminates at
  the published event and a stub receiver, and the phase is re-run to completion
  after Phase 9.)
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

## Phase 10 — Web

**Deliverables**

- Next.js App Router app consuming the API **through Kong**, never directly.
- Authentication flow against `identity/`, session handling, tenant context.
- Enough surface to be worth opening: catalog list, order creation, order detail,
  webhook subscription management.
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

## Standing rules across all phases

- The golden path (Phase 8) stays green from the moment it exists.
- A module never imports from another module's source tree.
- Every business table carries `tenant_id` with forced RLS, and every aggregate has
  a cross-tenant test.
- Coverage gates domain and application layers only, not infrastructure adapters.
- A folder appears when its phase begins, not before.
