# 47. Reporting projections never write back

- Status: accepted
- Date: 2026-09-15

## Context

The ERP's reports cross contexts: a cash-flow view needs titles from `financial/` and
entries from `treasury/`; a profitability view needs sales, costs and settlements; a
management dashboard needs all of them at once. Each context owns one database (ADR 0016)
with row-level security (ADR 0017), so no report can simply join.

Two shapes are possible: a reporting store that consumes events, or reports that reach into
operational databases. The second is faster to build and converts every operational schema
into a public interface — after which no service can migrate a table without breaking a
report.

There is also a timing question. The expansion needs reports long before it needs a
reporting service, and building the service first would delay every phase that only needs
its own data.

## Decision

Until a report genuinely spans contexts, it stays **inside the context that owns its
data** — aging inside `financial/`, statements inside `treasury/`, stock valuation inside
`inventory/`.

When cross-context reporting is introduced, a `reporting/` context consumes published
events and builds its own tenant-scoped read models, with forced row-level security like
every other store. It is a consumer only: it never writes to an operational database, never
calls an operational write endpoint, and holds no business rule that is not derivable from
the events it consumes.

Its read models are **rebuildable**. Replaying the event history into an empty reporting
database reproduces them, which is how a projection defect is fixed.

Because projections lag, every cross-domain report states the cutoff it was computed at,
and reconciliation against the owning context is a test, not an assumption.

## Consequences

- Operational schemas stay private and can migrate without coordinating with reports.
- Reports gain a query model shaped for reading — denormalized, indexed for the filters the
  UI offers — without slowing down the write path that produced the data.
- Reporting is eventually consistent, and the interface must say so. A figure presented
  without a cutoff is a defect.
- Every report that `reporting/` serves depends on the completeness of published events, so
  an event that was never published is a reporting gap, and adding a field to a projection
  requires a backfill from history.
- Until `reporting/` exists, some reports are duplicated per context. That is accepted:
  premature centralization would couple contexts that are still changing shape.

## Alternatives considered

**Cross-database queries or a shared reporting schema written by each service.** Removes
the projection work and reintroduces the shared-schema coupling that ADR 0016 rejected,
with the additional problem that the write path now owns report performance.

**Read replicas of operational databases, joined by a BI tool.** Standard and operationally
cheap, but it publishes internal schemas to a tool outside the repository's boundary checks,
and row-level security must then be reimplemented in the BI layer.

**A reporting context that also corrects data it finds inconsistent.** Superficially
helpful, and the fastest way to have two writers for one fact.
