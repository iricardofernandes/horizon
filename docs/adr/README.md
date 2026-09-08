# Architecture Decision Records

One record per settled decision, in [MADR](https://adr.github.io/madr/) form: Context,
Decision, Consequences, Alternatives considered.

These decisions are **settled**. A record exists to preserve the rationale — what was
known, what was traded away, and what was rejected — not to reopen the debate. Changing
one means writing a new ADR that supersedes it.

## Topology and tooling

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

## Data representation

| # | Decision |
|---|---|
| [0009](0009-uuidv7-public-identifiers.md) | UUIDv7 for all public identifiers |
| [0010](0010-money-as-integer-minor-units.md) | Money as integer minor units with explicit currency |
| [0011](0011-timestamptz-utc-storage.md) | `timestamptz`, UTC in storage, tenant timezone at presentation |

## Tenancy and persistence

| # | Decision |
|---|---|
| [0016](0016-one-database-per-module.md) | One database per module |
| [0017](0017-row-level-security-and-tenant-aware-transaction.md) | Row-Level Security and the `TenantAwareTransaction` |

## Authentication and authorization

| # | Decision |
|---|---|
| [0018](0018-eddsa-access-tokens.md) | EdDSA (Ed25519) access tokens instead of RS256 |
| [0019](0019-argon2id-password-hashing.md) | Argon2id via `@node-rs/argon2` |
| [0020](0020-opaque-rotating-refresh-tokens.md) | Opaque, rotating refresh tokens with reuse detection |
| [0021](0021-redis-jti-denylist-asymmetric-failure.md) | `jti` denylist in Redis, with asymmetric failure behaviour |
| [0022](0022-api-key-format-and-scopes.md) | API key format and scope model |
| [0023](0023-casl-static-module-scoped-roles.md) | CASL, with static, module-scoped roles |

## Integrity, resilience and privacy

| # | Decision |
|---|---|
| [0024](0024-transactional-outbox-and-inbox.md) | Transactional outbox, and inbox idempotency |
| [0025](0025-append-only-audit-log-with-hash-chain.md) | Append-only audit log with a per-tenant hash chain |
| [0026](0026-crypto-shredding-for-erasure.md) | Crypto-shredding for LGPD/GDPR erasure |
| [0027](0027-resilience-policy-for-outbound-calls.md) | Resilience policy for every outbound call |
| [0028](0028-idempotency-key-on-public-writes.md) | `Idempotency-Key` on public write endpoints |

## Contracts and code structure

| # | Decision |
|---|---|
| [0029](0029-contracts-distributed-through-a-registry.md) | `@horizon/contracts` distributed through a private registry |
| [0030](0030-event-naming-envelope-and-versioning.md) | Event naming, envelope, and version policy |
| [0031](0031-layering-and-object-calisthenics.md) | Clean Architecture layering, and which Object Calisthenics rules apply |
| [0032](0032-either-for-expected-failures-rfc9457-at-the-boundary.md) | `Either` for expected failures, RFC 9457 at the boundary |

## Testing, observability and operations

| # | Decision |
|---|---|
| [0013](0013-vitest-with-testcontainers.md) | Vitest, with Testcontainers for integration and e2e |
| [0014](0014-factories-and-in-memory-repositories.md) | Test factories and in-memory repositories |
| [0033](0033-opentelemetry-with-collector-fanout.md) | OpenTelemetry with a Collector fan-out |
| [0034](0034-terraform-written-but-never-applied.md) | Terraform written but never applied |
| [0035](0035-mcp-debugger-read-only-by-construction.md) | The MCP debugger is read-only by construction |
