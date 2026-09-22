# Phase 40 verification record

Phase 40 establishes the independent Fiscal service and durable records. This record
maps the [implementation plan](fiscal-implementation-plan.md#40--independent-fiscal-service-and-durable-records)
to code and executable evidence. It does not enable an authority capability or claim
homologation. Every model, environment and jurisdiction remains `unsupported`.

| Requirement | Implementation | Verification |
|---|---|---|
| Module, contracts, roles and integration | `fiscal/` is registered on port 3011; contracts 0.25.0 is exactly pinned; Identity grants four Fiscal roles; the API applies distinct read, draft, rules, transmission, cancellation and import permissions. Kong, Compose, Terraform, CI, Makefile, demo and web proxy include Fiscal. OpenTelemetry instruments the worker and API. | `make ci-local` checks module boundaries, pins, all package builds and tests; Fiscal auth and API unit tests verify signatures, revocation, permissions, tenant-scoped reads and unsupported capabilities. The local Kong route served `/fiscal/health` and authenticated API requests. |
| Tenant records and isolation | Migrations 0001–0009 add restricted owner projections, encrypted origin payloads and document snapshots, lines, number counters/reservations, source packages/rules, authority and cancellation attempts/responses, artifacts, imports/matches, idempotency, inbox, outbox and audit entries. Every tenant business table uses forced RLS; cross-record foreign keys include the tenant. Immutable facts and transition guards prevent history edits. | PostgreSQL/RabbitMQ Testcontainers suite runs all migrations as a non-superuser owner, checks forced RLS on all 27 business tables, and exercises duplicate inbox delivery, origin uniqueness, cross-tenant rejection, immutable drafts, concurrent numbering and audit verification. |
| Ports, simulation and artifacts | `AuthorityGateway`, `FiscalArtifactStore`, `CertificateProvider`, `Clock` and `RulePackageRepository` have interfaces; deterministic authority and local secret/rule implementations are available for simulation. The local and S3-compatible artifact stores encrypt with AES-256-GCM, use tenant/document/kind/digest object keys, write once and verify digest and size on read. Metadata records media type, source schema and creation time. Certificates are obtained by secret reference, without storing certificate bytes in business tables. | Local adapter test recreates the service and reads the same artifact, rejects another tenant and detects tampering. MinIO Testcontainers test confirms encrypted S3 storage, conditional writes, restart, versioning and recovery of a previous object version. |
| Business bucket and recovery | Terraform declares a private, versioned, server-encrypted bucket separate from Terraform state, with `GetObject`/`PutObject` limited to the Fiscal ECS task role. Compose provisions a versioned MinIO bucket. The [Terraform runbook](../infra/terraform/README.md) describes preserving the encryption key, restoring a known object version and verifying the database digest. | Terraform format, validation and dev/prod topology tests run without applying infrastructure. The MinIO test restores a prior version after corrupting the current object. |
| Document identity and uncertain outcome | One draft is allowed per tenant and Sales origin. Idempotency keys bind retries to the same request. Number reservation serializes document retries and increments a unique tenant/establishment/environment/model/series counter. Submission or cancellation attempt is committed before calling the simulator; a later process consults the recorded request instead of silently resubmitting or freeing its number. | PostgreSQL suite tests parallel reservations, duplicate requests, a crash before the simulator call, timeout, restart, reconciliation and cancellation. |

## Local Docker rollout, 2026-09-21

`make up-fiscal` built and started Fiscal, its migration job and the versioned MinIO
bucket in the existing local stack. Migrations 0001–0009 were applied to
`horizon_fiscal`. `make demo` produced Sales fiscal-origin events and Fiscal consumed
them. Through Kong, `/fiscal/health` returned 200, an authenticated
`/fiscal/capabilities` request returned `defaultStatus: unsupported`, and an issuer
created and read a simulation draft from a captured Sales event. The document read
reported `simulated: true` and `status: draft` without returning its encrypted
commercial snapshot. No external authority was contacted.

The first browser golden-path attempt exposed a stale local contracts tarball: an
Identity image accepted the new Fiscal role while issuing a token, then rejected that
same token at `/identity/me` because its installed `@horizon/contracts@0.24.0` did not
recognize the role. Contracts 0.25.0 was published to the local registry, exactly pinned
in all consumers and installed into clean service images. The rebuilt Identity image
accepts the Fiscal role; workspace selection and `/identity/me` both returned 200.
The browser golden path then passed with a joined trace across web, gateway, Inventory,
Sales, Financial and Webhooks.

Final local gates passed: `make ci-local` (repository checks, builds, unit tests and
service integration tests), `make test-phase10` (browser golden path), Terraform
format/validation and both dev/prod topology tests, Compose config validation,
documentation links and `git diff --check`. The Fiscal integration suite passed
11 tests across PostgreSQL/RabbitMQ and MinIO containers. Terraform was validated
without applying it to an AWS account.

Existing Phase 39 intents can lack the encrypted origin payload introduced in Phase
40. Before drafting one of those intents, replay the exact Sales owner event with a
new event ID, then verify its digest. The API rejects a draft without that payload;
it does not accept caller-supplied commercial facts. Each target environment still
needs its own tenant key provisioning, backfill reconciliation and migration rollout.
