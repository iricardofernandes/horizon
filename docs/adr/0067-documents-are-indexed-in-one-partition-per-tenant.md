# 67. Documents are indexed in one partition per tenant

- Status: accepted; the index is implemented in Phase 74 ([plan](../ai-phase74-implementation-plan.md),
  [evidence](../ai-phase74-evidence.md)), and search with roles inside the scan in Phase 75
  ([plan](../ai-phase75-implementation-plan.md), [evidence](../ai-phase75-evidence.md)).
  Phase 77 keeps the suggestion history the same way: `examples`, one partition per tenant.
  Revised in Phase 74: pgvector
  is compiled into the platform's own `postgres:17-alpine` image, not the Debian
  `pgvector/pgvector` one, because glibc would collate the cluster's `en_US.utf8` text
  differently from musl under existing B-tree indexes.
- Date: 2026-09-29

## Context

The roadmap stated the constraint before any code: retrieval must be scoped by tenant **at
the index**, not by filtering results. Post-filtering ranks every tenant's vectors and then
discards some. It leaks through ranking, through latency, and through any bug in the
filter. RLS gives the relational store that guarantee, but an approximate index built over
a whole table does not respect it.

## Decision

- **A new service, `knowledge/`,** on port 3016, database `horizon_knowledge`.
- **pgvector:** the platform's PostgreSQL image becomes `pgvector/pgvector:pg17`, pinned by
  digest.
- **`chunks` is `PARTITION BY LIST (tenant_id)`.**
  - Each tenant has its own partition and its own HNSW index, created when the tenant is
    first indexed.
  - A search runs in the tenant's context and is planned onto that partition alone.
  - CI proves it twice: by the query plan, and by a canary document in another tenant.
- **Forced RLS** stays on every table, as a second barrier.
- **Roles filter inside the scan** (pgvector iterative scan), not after it. The owning
  module's read role decides, as in `files/`.
- Only attachments that are `available` are indexed.

## Consequences

- One tenant's volume never changes another's ranking or latency.
- Partitions are created at run time, which the migration and restore tooling must handle.
- Changing the embedding model needs a re-embed per partition, tracked by an index version.

## Alternatives considered

**One index with a tenant filter.** Rejected: it is the post-filtering the roadmap forbids.

**A separate vector database** (Qdrant, Weaviate) with a collection per tenant. Viable.
Rejected for now: it adds a store outside RLS, the backups of Phase 69 and the restore
drill. pgvector keeps one recovery story.

**A database per tenant.** Rejected: nothing else in Horizon is shaped that way (ADR 0003).
