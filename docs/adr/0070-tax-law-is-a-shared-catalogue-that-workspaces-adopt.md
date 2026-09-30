# 70. Tax law is a shared catalogue that workspaces adopt

- Status: accepted. Implemented in Phase 82 ([plan](../tax-phase82-implementation-plan.md)).
- Date: 2026-09-30

## Context

Phase 41 stored source packages, reference tables and tax rules per tenant, under forced
RLS. The law is the same for every workspace, so a second workspace would import and
approve its own copy of it, and two copies could drift. What does differ between
workspaces is narrower: special regimes, court decisions, local agreements, and which
version of the law each has reviewed and accepted.

## Decision

- **Published rule packages form a catalogue with no tenant.**
  - Each package is immutable and identified by its source's digest.
  - The application role can only read the catalogue. Publishing uses the migration role,
    from a CLI.
- **Catalogue rules are law.** Their precedence is `operation` or `default`, and they may
  not be scoped to an establishment, a party or an item.
- **A workspace adopts a package version** from a date, naming the reviewer, the
  interpretation and the fixtures reviewed.
  - Adoption and withdrawal are append-only events, and the latest decides.
  - An adopted rule counts as approved, and applies from the later of its own start and
    the adoption's.
- **A workspace keeps its own rows** at `establishment`, `item`, `party` and `operation`
  precedence. Resolution reads adopted catalogue rules and the workspace's rows with Phase
  41's precedence.
- **An adoption that would tie with an active workspace rule is refused.** The workspace
  retires its rule first, since a tie makes resolution ambiguous.
- **A calculation lock never reads the catalogue again.** It replays from the rules it
  stored.

## Consequences

- A rate change is published once and adopted by each workspace when it has reviewed it.
- Every workspace on the same adopted version calculates the same way.
- Phase 41's package moves into the catalogue with its identifiers preserved, so its
  approved result keeps its digests.

## Alternatives considered

**Keep per-tenant copies, synchronized.** Rejected: synchronization is the drift it tries
to prevent, and a copy's approval says nothing about the source.

**Apply catalogue versions automatically.** Rejected: a workspace must be able to review a
change before its documents are calculated under it (ADR 0073, Phase 88's impact report).
