# Patterns

Each document here describes one cross-cutting pattern precisely enough that a new
module can **reimplement it locally**, without importing anything.

That is the deliberate consequence of [ADR 0001](../adr/0001-single-repository-of-independent-projects.md):
modules share no source. A shared `@horizon/kernel` package would be a fifth transport
between modules and would couple five release cycles. So patterns are copied, and these
documents are what makes copying reliable rather than archaeological.

**Status: phase 1 — empty by design.** These are written in **phase 5**, after
`identity/` has implemented each pattern once for real. Writing them earlier would
produce speculation; writing them from working code produces instructions.

## Planned contents

| Document | Extracted from | Covers |
|---|---|---|
| `tenant-transaction.md` | phase 4 | RLS policies, the forced-RLS role, `TenantAwareTransaction`, why the client is not exported |
| `transactional-outbox.md` | phase 4 | Table shape, the `FOR UPDATE SKIP LOCKED` relay, multi-replica safety, lag metrics |
| `inbox-idempotency.md` | phase 4 | Consumer deduplication inside the effect's transaction, retention windows |
| `audit-hash-chain.md` | phase 4 | Append-only enforcement, canonical JSON, per-tenant chaining, the verification command |
| `crypto-shredding.md` | phase 4 | Per-subject keys, blind indexes, propagation on erasure |
| `resilience.md` | phase 4 | Timeouts, breakers, backoff with jitter, prefetch, bulkheads, and the metrics for each |
| `error-taxonomy.md` | phase 4 | Typed errors, `Either` at the use-case boundary, RFC 9457 mapping |
| `tactical-kernel.md` | phase 4 | What `src/core/` contains, and why divergence between copies is permitted |
| `authorization.md` | phase 4 | CASL ability construction, the guard/use-case split for condition-level rules |
| `testing-strategy.md` | phase 4 | Factories, tenant-scoped in-memory repositories, the mandatory cross-tenant test |
| `new-module-checklist.md` | phase 5 | The literal sequence for standing up a module, followed verbatim in phase 6 |
| `zero-downtime-migration.md` | phase 6 | Expand/contract demonstrated end to end: add, backfill, dual-write, cut over, drop |

Phase 6 (`catalog/`) is the test of these documents: it is built by following the
checklist, and every gap found is fixed **here** rather than worked around in the module.
