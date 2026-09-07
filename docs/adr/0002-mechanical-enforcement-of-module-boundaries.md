# 2. Mechanical enforcement of module boundaries

- Status: accepted
- Date: 2026-09-07

## Context

ADR 0001 removes workspace tooling so that cross-module imports do not resolve. That
is necessary but not sufficient. A determined author can still add a `paths` entry, a
relative import that happens to resolve at runtime under `ts-node`, or a
`file:../catalog` dependency. Conventions erode under deadline pressure, and this
repository will be worked on intermittently over months.

The architecture's central claim — that these modules are independently deployable —
is falsified by a single successful cross-module import. The claim therefore needs a
check, not a rule.

## Decision

Isolation is enforced by four independent mechanisms, each of which fails loudly:

1. **`tsconfig.json` per module** sets `rootDir: "src"` and `paths` that resolve only
   within the module. A cross-module relative import fails to typecheck.
2. **`scripts/check-boundaries.mjs`** scans every module's source for imports that
   resolve outside its own directory, excluding `node_modules` and `@horizon/*`, and
   exits non-zero. It also enforces the layering rule of ADR 0031: `domain/` must not
   import from `application/`, `infrastructure/`, `@nestjs/*`, `drizzle-orm` or
   `zod`. It runs in CI and in the `pre-commit` hook.
3. **Docker build context** is the module directory alone. A build that needs a
   sibling's file fails.
4. **Isolated CI jobs** run each module's install, typecheck, lint and test with a
   sparse checkout containing only that directory, proving self-containment against
   the strongest possible test: the siblings are not on disk.

The set of module roots is a **declared list** in the boundary script, not "every
top-level directory", because `tooling/` is a container directory whose project is
`tooling/mcp-debugger/`.

## Consequences

- Four chances to catch the same class of mistake, at four different costs: seconds
  (typecheck), seconds (script), a minute (Docker), a few minutes (isolated CI).
- The boundary script is repository-level code that knows about all modules. It is
  the one permitted exception to "nothing at the root knows about module internals",
  and it is deliberately small and dependency-free.
- Adding a module means adding it to the declared list. Forgetting to means the
  module is unchecked, so the script also fails if a top-level directory containing a
  `package.json` is absent from the list.
- `@horizon/contracts` is excluded from the check by name. That package is the
  sanctioned coupling, and ADR 0029 constrains how it changes.

## Alternatives considered

**ESLint `import/no-restricted-paths` or `eslint-plugin-boundaries`.** The standard
answer. Rejected because Biome replaces ESLint (ADR 0012) and has no equivalent rule,
and because a lint rule is disabled by one inline comment. A separate script that
exits non-zero in CI has no inline escape hatch.

**Trusting `rootDir` alone.** Catches relative imports but not a `paths` entry, a
`file:` dependency, or a runtime `require`. Insufficient on its own.

**Nothing; rely on code review.** Rejected. The failure mode is silent and the
discovery point is deployment.
