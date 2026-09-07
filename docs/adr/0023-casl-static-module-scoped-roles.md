# 23. CASL, with static, module-scoped roles

- Status: accepted
- Date: 2026-09-07

## Context

Two questions must be answered independently.

First: are roles data or code? Tenant-editable roles are the standard ERP feature and
they are a permanent liability — permission checks become unanalysable, every
deployment risks a tenant's custom role, and no test can enumerate the reachable
states.

Second: is a role global or per-context? "Admin" as a single global role means the
person who administers the product catalog can also issue API keys and read every
customer record. In an ERP, where the warehouse supervisor and the sales manager are
different people with different trust, a single axis is wrong.

## Decision

**Roles are static and declared in code.** Not editable per tenant.

**Authorization is module-scoped and two-dimensional**: an independent role per
module. Full admin in `catalog/` implies nothing whatsoever in `sales/`.

- Assignments have the shape `{ module, role }[]`, are persisted in `identity/`, and
  are embedded in the access token.
- Permission identifiers are `<module>:<subject>:<action>` — e.g.
  `sales:order:confirm`.
- **Each module owns the static `role → permissions` map for its own subjects.**
  `identity/` stores opaque `(module, role)` pairs and does not know what they mean;
  it cannot, because that would make it a dependency of every module's authorization
  model.
- The valid **role names** per module are published through `@horizon/contracts`, so
  `identity/` can mint a well-formed token, and the receiving module **validates the
  claim independently on arrival** against its own map.
- The CASL `Ability` is built **per request** from the token claims, scoped to the
  current module. A missing role yields zero permissions — deny by default.
- At least one **condition-level** rule exists, demonstrating a permission granted only
  below a value threshold (a sales role that may confirm orders under a limit but not
  above it). Conditions are the reason CASL is used rather than a permission array.

## Consequences

- The complete permission surface is enumerable from source. A reviewer can read every
  role in every module in a few minutes, and a test asserts every declared permission
  is reachable and every reachable action is declared.
- Compromising `identity/` yields tokens with role *names*; it does not yield an
  expanded permission set, because expansion happens in the target module.
- A role change is a deployment, not a support action. Accepted, and stated in the
  product documentation as a deliberate constraint rather than a missing feature.
- Tokens carry roles rather than permissions, so they stay small and a permission map
  change takes effect without reissuing tokens.
- Condition-level rules need the subject instance to evaluate, so authorization for
  those actions happens after the aggregate is loaded — inside the use case, not in a
  guard. The guard checks the coarse permission; the use case checks the condition.
  Both are required, and the split is documented in
  `docs/patterns/authorization.md`.
- CASL is used only in `application/` and `infrastructure/`. `domain/` never sees it,
  and never imports `@horizon/contracts` either — permission names reach the domain, if
  at all, as plain arguments.

## Alternatives considered

**Tenant-editable roles stored as data.** The expected ERP feature. Rejected as
described in Context; this is a portfolio system that values analysability over
configurability, and the decision is documented rather than hidden.

**A single global role dimension.** Rejected: it forces over-granting.

**Permissions embedded directly in the token.** Rejected: token bloat, and a
permission map change would require every token to be reissued.

**A central authorization service.** Rejected: a synchronous dependency on every
request in every module, for a decision each module can make locally in microseconds.
