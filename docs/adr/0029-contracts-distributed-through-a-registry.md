# 29. `@horizon/contracts` distributed through a private registry

- Status: accepted
- Date: 2026-09-07

## Context

`contracts/` holds the Zod schemas for every published event and cross-module HTTP
payload, the inferred types, and the per-module role and permission name maps. It is
the one sanctioned coupling between modules (ADR 0002), which makes *how* it is
distributed an architectural decision rather than a packaging detail.

Under ADR 0001 there is no workspace, so the obvious shortcut is a `file:../contracts`
dependency. That shortcut destroys the property the topology exists to protect: a
`file:` dependency resolves through the filesystem, so a module silently consumes
whatever is on disk. There is no version, so a breaking change to a schema is invisible
until something fails at runtime, and the producer and consumer can never be
demonstrated to disagree — they are, by construction, always in agreement with the
working tree.

## Decision

**A local Verdaccio registry**, run in `infra/docker-compose.yml`.

- `contracts/` publishes with a **semver version**.
- Each module depends on a **pinned version**, with `.npmrc` pointing `@horizon:` at
  the registry.
- **`file:` dependencies are rejected**, and the boundary script (ADR 0002) fails on
  one.

**Fallback, documented in advance:** if publish friction proves excessive in Phase 3,
the fallback is a versioned `npm pack` tarball committed to a `contracts/dist/`
directory and depended on by path-to-tarball. That keeps explicit versioning — the
tarball name carries the version and changing the dependency is a visible diff — without
running a registry. It is a fallback, not a preference, and taking it requires
amending this ADR.

**In CI**, where a module's job runs with a sparse checkout of only its own directory
(ADR 0002), Verdaccio is not available as a developer's local container. The contracts
package is published by a prior job to the workflow's registry — a Verdaccio service
container seeded from the published artefact, or GitHub Packages — and module jobs
install from there. The protocol is identical; only the host differs, so no module
configuration changes between local and CI beyond a registry URL.

## Consequences

- A module's dependency on a contract is **a version in `package.json`**: visible in a
  diff, reviewable, and pinned.
- Producer and consumer can legitimately be on different versions, which is what makes
  the deprecation window of ADR 0030 expressible at all. Under `file:`, "both versions
  emitted during a deprecation window" is not representable.
- Upgrading a consumer is a deliberate act. The friction is the feature: it is the
  moment someone reads what changed.
- One more container in the local stack, and a publish step in the contracts workflow.
- A developer changing a schema must publish before a consumer can use it, which is
  slower than saving a file. Mitigated by prerelease versions during development.

## Alternatives considered

**`file:` or `link:` dependency.** Rejected as described in Context.

**Copying the schemas into each module.** Consistent with the duplication elsewhere
(ADR 0001) and rejected here specifically: a wire contract has exactly two sides, and
duplicating it means the two sides can silently diverge — which is the one failure the
package exists to prevent. Patterns are copied; contracts are versioned.

**Publishing publicly to npm.** Rejected for now: the package has no external consumer,
and public publication is an irreversible act for an unfinished schema. If the API ever
has third-party client generation, this is revisited.

**Git submodule or subtree.** Rejected: version resolution by commit hash, with none of
npm's range semantics and much worse ergonomics.
