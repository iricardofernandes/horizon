# 15. Conventional Commits, enforced by lefthook and commitlint

- Status: accepted
- Date: 2026-09-07

## Context

The commit history of a public portfolio repository is read. It is the only artefact
that shows how the work actually proceeded, and it is the one thing that cannot be
retrofitted.

It is also functional: with path-filtered CI across ten projects, a commit's scope is
the fastest way to see what a change touched, and contract versioning (ADR 0030)
depends on being able to tell an additive change from a breaking one at review time.

## Decision

**Conventional Commits**, enforced by commitlint. Types: `feat`, `fix`, `refactor`,
`docs`, `test`, `chore`, `perf`, `ci`. **Scopes are module names**, so
`feat(inventory): reserve stock on order confirmation` is legible without opening the
diff.

Git hooks are managed by **lefthook**:

| Hook | Runs |
|---|---|
| `pre-commit` | Biome on staged files; typecheck of affected projects |
| `commit-msg` | commitlint |
| `pre-push` | unit tests of affected projects |

"Affected" is computed from the staged or pushed paths against the declared module
list of ADR 0002 — the same list, so the two cannot drift.

E2E tests and Docker builds are **not** in a hook. They belong in CI; a `pre-push`
that takes four minutes gets bypassed.

## Consequences

- The history is machine-readable, so a changelog can be generated and a contract
  version bump can be checked against the commit type.
- Hooks run only what the change touched, so committing to `docs/` costs nothing.
- lefthook is a single Go binary with no Node dependency tree, installed per
  repository root rather than per module — the one repository-level tool besides the
  boundary script.
- Hooks are bypassable with `--no-verify`. That is acceptable: CI runs the same checks
  and is not bypassable. The hooks exist to shorten the feedback loop, not to be the
  gate.
- PR titles are linted by the same rules in CI, since a squash-merge takes its message
  from the title.

## Alternatives considered

**Husky + lint-staged.** The common choice. Rejected: it adds a Node dependency and a
`node_modules` at the repository root, which ADR 0001 otherwise avoids entirely — the
root has no `package.json`.

**No hooks; CI only.** Rejected: the feedback loop matters, and a formatting-only CI
failure wastes a full pipeline run.

**Free-form commit messages.** Rejected for the reasons in Context.
