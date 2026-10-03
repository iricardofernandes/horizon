# Architecture Decision Records

One record per settled decision, in [MADR](https://adr.github.io/madr/) form: Context,
Decision, Consequences, Alternatives considered.

These decisions are **settled**. A record exists to preserve the rationale — what was
known, what was traded away, and what was rejected — not to reopen the debate. Changing
one means writing a new ADR that supersedes it.

## Start with these

The decisions a reviewer is most likely to question, and the one-line reason for each:

| Decision | Why | ADR |
|---|---|---|
| One repository, independent projects, **no workspace** | With workspace tooling a cross-module import typechecks and passes CI; without it, it cannot resolve | [0001](0001-single-repository-of-independent-projects.md) |
| Boundaries enforced mechanically, including a sparse checkout in CI | Conventions erode; the strongest test is that the siblings are not on disk | [0002](0002-mechanical-enforcement-of-module-boundaries.md) |
| A database per module | A shared schema undoes in persistence the boundary enforced in source | [0016](0016-one-database-per-module.md) |
| RLS, forced, with an unexported database client | A forgotten `WHERE tenant_id` returns nothing instead of someone else's data | [0017](0017-row-level-security-and-tenant-aware-transaction.md) |
| Transactional outbox + inbox | Commit-then-publish loses events silently; exactly-once delivery does not exist | [0024](0024-transactional-outbox-and-inbox.md) |
| Append-only audit with a per-tenant hash chain | An audit log that can be rewritten is not evidence | [0025](0025-append-only-audit-log-with-hash-chain.md) |
| Crypto-shredding for erasure | Erasure and an immutable chain contradict each other; destroying the key resolves it, and reaches backups | [0026](0026-crypto-shredding-for-erasure.md) |
| Contracts through a registry, never `file:` | A `file:` dependency has no version, so it cannot express a breaking change | [0029](0029-contracts-distributed-through-a-registry.md) |
| Posted records are reversed, never edited | The books must be able to explain every number they ever showed | [0042](0042-posted-records-are-reversed.md) |
| Segregation of duties is a declared matrix | Who may approve what is reviewed as data, and the database refuses self-approval | [0062](0062-segregation-of-duties-is-a-declared-matrix.md) |
| Recovery is measured by drills | A backup is only a claim until a restore has been timed | [0063](0063-recovery-is-measured-by-drills.md) |
| The tenant's agent is a stateless MCP adapter, and its writes are drafts | An AI reads with the person's permissions and never commits a change a person has not confirmed | [0065](0065-the-tenant-agent-is-a-stateless-mcp-adapter.md), [0066](0066-agent-writes-are-drafts.md) |
| Tax law is a shared catalogue that workspaces adopt | A rate change is a new package version, and a locked document replays byte for byte | [0070](0070-tax-law-is-a-shared-catalogue-that-workspaces-adopt.md) |
| A tax scenario is supported only with evidence | The official calculator's agreement or an approved fixture; anything else is refused, not guessed | [0072](0072-a-tax-scenario-is-supported-only-with-evidence.md) |
| AWS infrastructure as code, tested in CI but not deployed to a paid account | `fmt`, `validate` and `terraform test` run for both environments on every push; a live stack would cost money every month, so no workflow may apply it, and its estimated cost is stated | [0034](0034-terraform-written-but-never-applied.md) |

Two weaknesses are deliberate and documented rather than hidden: revocation **fails open
for reads** during a Redis outage
([0021](0021-redis-jti-denylist-asymmetric-failure.md)), and roles are not
editable per tenant ([0023](0023-casl-static-module-scoped-roles.md)).

## Why this stack

| Choice | Why | ADR |
|---|---|---|
| Node 24 and TypeScript strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` | One runtime in every image, and a type system that makes a missing value visible | [0005](0005-node-24-and-typescript-strictness.md) |
| NestJS for services | Its dependency injection is the seam Clean Architecture needs: an abstract class is both the interface and the runtime token | [0006](0006-nestjs-services-nextjs-frontend.md) |
| Next.js for the portal | Server rendering and a backend-for-frontend that keeps the session in an HttpOnly cookie | [0006](0006-nestjs-services-nextjs-frontend.md) |
| PostgreSQL 17 and Drizzle | Drizzle binds a transaction to one connection, so the tenant set with `SET LOCAL` holds for every statement in it | [0007](0007-drizzle-and-postgresql-17.md) |
| pgvector | The document index stays in PostgreSQL, partitioned by tenant, under the same RLS and backups as everything else | [0067](0067-documents-are-indexed-in-one-partition-per-tenant.md) |
| RabbitMQ | The transport for the transactional outbox: per-consumer queues, redelivery and dead letters, while correctness stays in the outbox and inbox | [0024](0024-transactional-outbox-and-inbox.md) |
| Redis | The token denylist, idempotency keys and rate counters: short-lived state with a declared behaviour when Redis is down | [0021](0021-redis-jti-denylist-asymmetric-failure.md) |
| Kong, DB-less | The whole gateway, with routes, JWT validation and rate limits, is one declarative file in version control | [0008](0008-kong-dbless-declarative-gateway.md) |
| EdDSA tokens and Argon2id | Small, fast signatures with no padding or nonce to get wrong; memory-hard password hashing with prebuilt binaries | [0018](0018-eddsa-access-tokens.md), [0019](0019-argon2id-password-hashing.md) |
| MinIO and ClamAV | Attachments in S3-compatible storage, scanned before they are ever served, encrypted under their owner's key | [0060](0060-attachments-are-a-files-module.md) |
| OpenTelemetry, with Jaeger, Prometheus, Loki and Grafana | One collector as the single ingestion point; backends can change without touching a service | [0033](0033-opentelemetry-with-collector-fanout.md) |
| Vitest and Testcontainers | Integration tests run against real PostgreSQL, Redis and RabbitMQ, because roles and forced RLS are what they test | [0013](0013-vitest-with-testcontainers.md) |
| Biome | One binary and one config for linting and formatting, instead of ESLint plus Prettier | [0012](0012-biome-replaces-eslint-and-prettier.md) |
| Terraform for AWS, tested but not applied | `fmt`, `validate` and `terraform test` on every push; a live stack would cost money every month | [0034](0034-terraform-written-but-never-applied.md) |

## All records by area

### Topology and tooling

| # | Decision |
|---|---|
| [0001](0001-single-repository-of-independent-projects.md) | Single repository of independent projects |
| [0002](0002-mechanical-enforcement-of-module-boundaries.md) | Mechanical enforcement of module boundaries |
| [0003](0003-module-set-and-independent-deployability.md) | Module set and independent deployability |
| [0004](0004-npm-as-package-manager.md) | npm as package manager |
| [0005](0005-node-24-and-typescript-strictness.md) | Node 24 and the TypeScript strictness baseline |
| [0006](0006-nestjs-services-nextjs-frontend.md) | NestJS for services, Next.js for the frontend |
| [0007](0007-drizzle-and-postgresql-17.md) | Drizzle and PostgreSQL 17 |
| [0008](0008-kong-dbless-declarative-gateway.md) | Kong in DB-less declarative mode |
| [0036](0036-kong-oss-has-no-jwks-so-the-gateway-config-is-rendered.md) | Kong OSS has no JWKS plugin, so the gateway configuration is rendered |
| [0012](0012-biome-replaces-eslint-and-prettier.md) | Biome replaces ESLint and Prettier |
| [0015](0015-conventional-commits-lefthook-commitlint.md) | Conventional Commits, lefthook, commitlint |

### Data representation

| # | Decision |
|---|---|
| [0009](0009-uuidv7-public-identifiers.md) | UUIDv7 for all public identifiers |
| [0010](0010-money-as-integer-minor-units.md) | Money as integer minor units with explicit currency |
| [0011](0011-timestamptz-utc-storage.md) | `timestamptz`, UTC in storage, tenant timezone at presentation |
| [0043](0043-precision-beyond-the-minor-unit.md) | Precision beyond the minor unit: scaled rates, business dates and rounding snapshots |

### Tenancy and persistence

| # | Decision |
|---|---|
| [0016](0016-one-database-per-module.md) | One database per module |
| [0017](0017-row-level-security-and-tenant-aware-transaction.md) | Row-Level Security and the `TenantAwareTransaction` |

### Authentication and authorization

| # | Decision |
|---|---|
| [0018](0018-eddsa-access-tokens.md) | EdDSA (Ed25519) access tokens instead of RS256 |
| [0019](0019-argon2id-password-hashing.md) | Argon2id via `@node-rs/argon2` |
| [0020](0020-opaque-rotating-refresh-tokens.md) | Opaque, rotating refresh tokens with reuse detection |
| [0021](0021-redis-jti-denylist-asymmetric-failure.md) | `jti` denylist in Redis, with asymmetric failure behaviour |
| [0022](0022-api-key-format-and-scopes.md) | API key format and scope model |
| [0023](0023-casl-static-module-scoped-roles.md) | CASL, with static, module-scoped roles |
| [0037](0037-tenant-directory-before-authentication.md) | Minimal tenant directory before authentication (superseded for interactive login) |
| [0038](0038-global-account-before-workspace-selection.md) | Global account before workspace selection |
| [0075](0075-one-broker-identity-per-module.md) | Each module has a broker identity of its own, and publishes only its own events |

### Integrity, resilience and privacy

| # | Decision |
|---|---|
| [0024](0024-transactional-outbox-and-inbox.md) | Transactional outbox, and inbox idempotency |
| [0025](0025-append-only-audit-log-with-hash-chain.md) | Append-only audit log with a per-tenant hash chain |
| [0026](0026-crypto-shredding-for-erasure.md) | Crypto-shredding for LGPD/GDPR erasure |
| [0027](0027-resilience-policy-for-outbound-calls.md) | Resilience policy for every outbound call |
| [0028](0028-idempotency-key-on-public-writes.md) | `Idempotency-Key` on public write endpoints |
| [0042](0042-posted-records-are-reversed.md) | Posted records are reversed, never edited |

### Contracts and code structure

| # | Decision |
|---|---|
| [0029](0029-contracts-distributed-through-a-registry.md) | `@horizon/contracts` distributed through a private registry |
| [0030](0030-event-naming-envelope-and-versioning.md) | Event naming, envelope, and version policy |
| [0031](0031-layering-and-object-calisthenics.md) | Clean Architecture layering, and which Object Calisthenics rules apply |
| [0032](0032-either-for-expected-failures-rfc9457-at-the-boundary.md) | `Either` for expected failures, RFC 9457 at the boundary |

### Business contexts

| # | Decision |
|---|---|
| [0040](0040-shared-party-registry.md) | A shared party registry, with role-fed projections |
| [0041](0041-financial-treasury-ledger-boundaries.md) | Financial, treasury and ledger are three boundaries |
| [0046](0046-reconciliation-suggests-a-human-confirms.md) | Reconciliation suggests, a human confirms |
| [0047](0047-reporting-projections-never-write-back.md) | Reporting projections never write back |
| [0048](0048-fiscal-origin-and-operational-ownership.md) | Fiscal origin and operational ownership |
| [0049](0049-restricted-fiscal-profile-projections.md) | Restricted fiscal profile projections |
| [0050](0050-fiscal-authorizer-follows-issuer-jurisdiction.md) | The NF-e authorizer follows the issuer's jurisdiction |
| [0051](0051-supplier-xml-is-evidence-not-an-operational-fact.md) | A supplier NF-e is evidence, not an operational fact |
| [0052](0052-returns-and-complements-are-linked-documents.md) | Returns and complements are linked documents over owner facts |
| [0053](0053-nfce-is-a-separate-model-over-the-sales-shipment.md) | NFC-e is a separate model over the same Sales shipment |
| [0054](0054-national-nfse-is-keyed-by-municipality-and-reconciled-by-dps.md) | The national NFS-e is keyed by municipality and reconciled by its DPS |
| [0055](0055-fiscal-support-reads-metrics-and-bounded-replay.md) | Fiscal support reads the API, measures without tenants and replays within bounds |
| [0056](0056-services-are-delivered-by-service-orders-inside-sales.md) | Services are delivered by service orders inside Sales, and billed once per period |
| [0057](0057-crm-accounts-are-parties-with-typed-documents.md) | CRM accounts are parties, and a party's document is typed |

### Production readiness

| # | Decision |
|---|---|
| [0058](0058-reporting-keeps-a-sealed-event-journal.md) | Reporting keeps a sealed event journal, and a cutoff settles on seals |
| [0059](0059-bulk-data-jobs-belong-to-the-owning-module.md) | Bulk data jobs belong to the module that owns the data |
| [0060](0060-attachments-are-a-files-module.md) | Attachments are a `files` module, scanned before served and shredded with their owner |
| [0061](0061-access-hardening-stays-in-identity.md) | Access hardening stays in Identity: invitations, MFA, passkeys and visible sessions |
| [0062](0062-segregation-of-duties-is-a-declared-matrix.md) | Segregation of duties is a declared matrix, enforced by each module, with delegation |
| [0063](0063-recovery-is-measured-by-drills.md) | Recovery is measured by drills, and retention is declared per table class |

### AI with isolation

| # | Decision |
|---|---|
| [0064](0064-api-keys-reach-modules-through-scoped-tokens.md) | API keys reach modules through short tokens that carry their scopes |
| [0065](0065-the-tenant-agent-is-a-stateless-mcp-adapter.md) | The tenant's agent server is a stateless MCP adapter with no privileged path |
| [0066](0066-agent-writes-are-drafts.md) | An agent's writes are drafts, and a draft by a key is its issuer's |
| [0067](0067-documents-are-indexed-in-one-partition-per-tenant.md) | Documents are indexed in one partition per tenant |
| [0068](0068-derived-ai-data-follows-its-source.md) | Derived AI data follows its source's erasure and retention |
| [0069](0069-models-are-ports-and-generation-is-opt-in.md) | Models are ports, generation is opt-in, and nothing depends on them |

### The tax rules engine

| # | Decision |
|---|---|
| [0070](0070-tax-law-is-a-shared-catalogue-that-workspaces-adopt.md) | Tax law is a shared catalogue that workspaces adopt |
| [0071](0071-tax-formulas-are-data-over-a-closed-vocabulary.md) | Tax formulas are data over a closed vocabulary |
| [0072](0072-a-tax-scenario-is-supported-only-with-evidence.md) | A tax scenario is supported only with evidence |
| [0073](0073-tax-estimates-outside-fiscal-amounts-inside-it.md) | Tax estimates outside Fiscal, amounts inside it |
| [0074](0074-a-tax-rule-change-is-requested-and-approved-by-another-person.md) | A tax rule change is requested and approved by another person, with its diff and impact |
| [0076](0076-taxes-follow-the-authority-and-estimates-are-kept-by-reference.md) | Taxes are posted when the authority authorizes, and an estimate is kept by reference |

### Frontend

| # | Decision |
|---|---|
| [0039](0039-frontend-design-system-foundation.md) | Inter, Phosphor, Base UI and Radix Colors as the frontend foundation |
| [0044](0044-localization-stops-at-the-presentation-boundary.md) | Localization stops at the presentation boundary |
| [0045](0045-routed-shell-with-permission-navigation-registry.md) | A routed frontend shell with a permission-driven navigation registry |

### Testing, observability and operations

| # | Decision |
|---|---|
| [0013](0013-vitest-with-testcontainers.md) | Vitest, with Testcontainers for integration and e2e |
| [0014](0014-factories-and-in-memory-repositories.md) | Test factories and in-memory repositories |
| [0033](0033-opentelemetry-with-collector-fanout.md) | OpenTelemetry with a Collector fan-out |
| [0034](0034-terraform-written-but-never-applied.md) | Terraform written but never applied |
| [0035](0035-mcp-debugger-read-only-by-construction.md) | The MCP debugger is read-only by construction |
