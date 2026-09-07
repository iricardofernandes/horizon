# 1. Single repository of independent projects

- Status: accepted
- Date: 2026-09-07

## Context

Horizon is composed of ten top-level projects that must be independently
deployable. Two conventional options exist: many repositories, or one repository
with workspace tooling (pnpm workspaces, npm workspaces, Turborepo, Nx).

Many repositories make the system hard to read as a whole — a reviewer would have to
clone ten things to see one architecture, and this repository's primary function is
to be read.

Workspace tooling makes the system easy to read and easy to accidentally couple. A
workspace hoists `node_modules`, shares a lockfile, and resolves sibling packages by
path. Under it, `import { Money } from '../../catalog/src/domain/money'` typechecks,
runs, passes CI, and is discovered only when someone tries to deploy `sales` without
`catalog`. The tooling that makes a monorepo pleasant is the same tooling that
dissolves the boundary the architecture depends on.

## Decision

One git repository, initialized at the root only. Each top-level folder is an
independent project with its own `package.json`, lockfile, `node_modules`,
`tsconfig.json`, `biome.json`, `Dockerfile`, test setup, migrations and README.

**No pnpm workspaces, no npm workspaces, no Turborepo, no Nx.** Modules behave as if
each lived in a separate GitHub repository that happens to be vendored side by side.

Cross-module communication occurs only through HTTP via Kong, asynchronous events
over RabbitMQ, or the published `@horizon/contracts` package.

## Consequences

- A cross-module relative import cannot resolve, because there is no shared
  resolution root. The mistake fails at typecheck rather than at deploy.
- Each module's `npm ci` is reproducible from its own lockfile with no knowledge of
  its siblings.
- Each Dockerfile's build context is its own directory; needing a sibling's file
  breaks the build, which is the intended feedback.
- Shared code is genuinely duplicated. The tactical DDD kernel (`src/core/`) is
  copied into every module and permitted to diverge. See ADR 0031.
- Dependency upgrades are per-module work. Ten `package.json` files drift. Dependabot
  is configured per directory, and drift is accepted as the cost of the boundary.
- Install and CI time is higher than a hoisted workspace. Mitigated by path-filtered
  CI: a change in one module does not build the others.
- There is no single command that builds everything. A root `Makefile` orchestrates,
  but it shells out per project rather than sharing a graph.

## Alternatives considered

**pnpm workspaces with `workspace:` protocol.** Fastest installs, shared lockfile,
excellent DX. Rejected: it makes the boundary a convention rather than a mechanism,
and the whole point of the topology is that the boundary is mechanical.

**Turborepo or Nx.** Adds task-graph caching on top of a workspace. Rejected for the
same reason, plus a second: the task graph itself encodes cross-project knowledge at
the root, which contradicts "each module behaves as if it were its own repository".

**Ten separate repositories.** Genuinely enforces isolation. Rejected because the
repository is a portfolio artefact — a reviewer must be able to see the whole system
in one place — and because ten repositories make an atomic contract change across
producer and consumer impossible to review.
