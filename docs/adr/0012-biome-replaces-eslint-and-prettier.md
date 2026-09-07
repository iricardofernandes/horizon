# 12. Biome replaces ESLint and Prettier

- Status: accepted
- Date: 2026-09-07

## Context

Ten independent projects each need linting and formatting. Under ADR 0001 there is no
shared configuration package, so whatever is chosen is copied ten times and must be
cheap to install, cheap to run, and cheap to keep consistent.

An ESLint + Prettier setup means two tools, two configs, a plugin to stop them
fighting, a parser, a TypeScript plugin, and several plugin packages — repeated ten
times, with ten opportunities to drift and ten dependency trees to keep patched.

## Decision

**Biome** replaces ESLint and Prettier entirely. One binary, one `biome.json` per
project, one pass for both linting and formatting.

Formatting settings, identical in every project:

```json
{
  "semicolons": "asNeeded",
  "quoteStyle": "single",
  "trailingCommas": "all",
  "arrowParentheses": "always"
}
```

Organize-imports is on with a deterministic group order, so import blocks do not
produce diff noise.

The `@/*` alias resolves to each project's own `src/*` and never outside it.

## Consequences

- Roughly an order of magnitude faster than ESLint on the same tree, which matters
  because Biome runs in the `pre-commit` hook (ADR 0015) on every commit.
- One dependency instead of eight or nine, ten times over.
- Biome has no equivalent of `import/no-restricted-paths`, so architectural boundary
  enforcement moves to `scripts/check-boundaries.mjs` (ADR 0002). This is arguably an
  improvement: a script has no inline-comment escape hatch.
- Biome's rule catalogue is smaller than ESLint's with the TypeScript and Unicorn
  plugin sets. Rules that exist only in ESLint are not available. Accepted; none of
  them were load-bearing.
- `useImportType` is disabled in the NestJS service modules for the reason given in
  ADR 0005 — it would silently break dependency injection.

## Alternatives considered

**ESLint 9 flat config + Prettier.** The mainstream choice, the largest rule
catalogue. Rejected on the multiplication cost of ADR 0001 and on speed in the commit
hook.

**oxlint.** Faster still, but formatting is separate and the project would be back to
two tools.

**Biome for formatting, ESLint for linting.** The worst of both: two tools, and the
speed benefit lost on the slower half.
