# Patterns

Each document here describes one cross-cutting pattern precisely enough that a new
module can **reimplement it locally**, without importing anything.

That is the deliberate consequence of [ADR 0001](../adr/0001-single-repository-of-independent-projects.md):
modules share no source. A shared `@horizon/kernel` package would be a fifth transport
between modules and would couple five release cycles. So patterns are copied, and these
documents are what makes copying reliable rather than archaeological.

**Status: phase 5 — extracted from Identity.** The recipes name concrete source files,
required adaptations and tests. Operational limits are stated where the implementation
cannot establish a broader claim (backup erasure, tail truncation and future consumers).
No shared runtime library is introduced.

## Recipes

| Document | Extracted from | Covers |
|---|---|---|
| [tenant-transaction.md](tenant-transaction.md) | Identity implementation and tests | RLS policies, the forced-RLS role, `TenantAwareTransaction`, why the client is not exported |
| [transactional-outbox.md](transactional-outbox.md) | Identity implementation and tests | Table shape, the `FOR UPDATE SKIP LOCKED` relay, multi-replica safety, lag metrics |
| [inbox-idempotency.md](inbox-idempotency.md) | Identity implementation and tests | Consumer deduplication inside the effect's transaction, retention windows |
| [audit-hash-chain.md](audit-hash-chain.md) | Identity implementation and tests | Append-only enforcement, canonical JSON, per-tenant chaining, the verification command |
| [crypto-shredding.md](crypto-shredding.md) | Identity implementation and tests | Per-subject keys, blind indexes, propagation on erasure |
| [resilience.md](resilience.md) | Identity implementation and tests | Timeouts, breakers, backoff with jitter, prefetch, bulkheads, and the metrics for each |
| [error-taxonomy.md](error-taxonomy.md) | Identity implementation and tests | Typed errors, `Either` at the use-case boundary, RFC 9457 mapping |
| [tactical-kernel.md](tactical-kernel.md) | Identity implementation and tests | What `src/core/` contains, and why divergence between copies is permitted |
| [authorization.md](authorization.md) | Identity implementation and tests | CASL ability construction, the guard/use-case split for condition-level rules |
| [testing-strategy.md](testing-strategy.md) | Identity implementation and tests | Factories, tenant-scoped in-memory repositories, the mandatory cross-tenant test |
| [new-module-checklist.md](new-module-checklist.md) | phase 5 | The literal sequence for standing up a module, followed verbatim in phase 6 |
| [zero-downtime-migration.md](zero-downtime-migration.md) | Catalog implementation and PostgreSQL e2e test | Expand/contract demonstrated end to end: add, dual-write, backfill, cut over, drop |

Phase 6 (`catalog/`) is the test of these documents: it is built by following the
checklist, and every gap found is fixed **here** rather than worked around in the module.
