# 4. npm as package manager

- Status: accepted
- Date: 2026-09-07

## Context

ADR 0001 removes workspaces. pnpm's principal advantages — a content-addressed store
shared across workspace packages, strict non-flat `node_modules`, and the
`workspace:` protocol — are advantages *of a workspace*. Without one, each project
installs independently and the store is the only remaining benefit.

## Decision

**npm**, with a lockfile per project and `npm ci` in CI and in every Docker build.

## Consequences

- Zero extra tooling to install. `node:24-alpine` ships npm; a Dockerfile needs no
  `corepack enable` step and no pinned package-manager version.
- Ten `package-lock.json` files. Each is independently auditable and independently
  upgradeable, which is what ADR 0001 wants.
- Disk usage is worse than pnpm's store: ten full `node_modules` trees. Accepted;
  local disk is cheap and CI caches per directory.
- npm's flat `node_modules` permits phantom dependencies — importing a transitive
  package that is not in `package.json`. Mitigated by the boundary script, which
  flags imports of packages absent from the module's own `dependencies`.
- `.npmrc` per module points `@horizon:registry` at Verdaccio (ADR 0029).

## Alternatives considered

**pnpm without workspaces.** Keeps the store, keeps strict resolution (which would
remove the phantom-dependency risk above). Rejected on the narrower grounds that it
adds a required toolchain step to every Dockerfile and every contributor's machine to
buy disk space that is not scarce. This is the closest call among the tooling ADRs; if
phantom dependencies become a real problem in practice, pnpm is the fallback and the
migration is mechanical.

**Yarn (Berry).** PnP resolution would break Nest's runtime `require` behaviour and
several tools' expectations. Rejected.

**Bun.** Fast, but Nest, Drizzle and Testcontainers all target Node, and the project
already commits to Node 24 (ADR 0005). Rejected as an unnecessary variable.
