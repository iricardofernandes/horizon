# 67. Documents are indexed in one partition per tenant

- Status: accepted; planned for Phases 74–75 ([Phase N plan](../ai-implementation-plan.md)).
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
