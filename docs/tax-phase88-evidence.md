# Phase 88 evidence — Governing the rules

[Plan](tax-phase88-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[ADR 0074](adr/0074-a-tax-rule-change-is-requested-and-approved-by-another-person.md) ·
[Drill](drills/2026-10-01-phase88-rule-governance.json)

## What was delivered

- **Contracts 0.62.0, additive** (0 breaking, 7 schemas added):
  - the catalogue package list;
  - the workspace's rules;
  - the rule diff;
  - the change request (four kinds), the change with its impact and decision, the change
    list, and the decision body.

  ADR 0062's matrix gains `fiscal.rules` (`fiscal:rules:request` / `fiscal:rules:approve`).
- **Fiscal, migration `0060`** adds three tables, all with forced RLS:
  - `fiscal_rule_changes`, immutable;
  - `fiscal_rule_change_decisions`, one per change and immutable. A trigger refuses a
    decision by the requester, in person or on her behalf, and a cancellation by anyone else;
  - `fiscal_approval_delegations`, which takes one revocation and nothing else.
- **`FiscalRuleChanges`** (`rule-changes.ts`, `rule-change-plans.ts`):
  - **Requesting** checks that the change can be made now:
    - an adoption needs the package not adopted and no tie with an active own rule;
    - a new rule needs a valid definition, a precedence other than `default`, valid
      formulas, a new key and version, and no tie with an own row or an adopted rule;
    - a retirement needs the rule to be active.
  - Two pending requests never concern the same package or rule.
  - **Approving** resolves the authority, by role or through a delegation, refuses the
    requester (`segregation-of-duties`, pair `fiscal.rules`), and applies the change in the
    same transaction:
    - an adoption or a withdrawal, which only this path records now (`recordAdoption`,
      `recordWithdrawal`);
    - a rule: its own source package, whose bytes the requester retains and the approver
      reviews, then the rule and its activation;
    - a retirement: its deactivation.
  - Rejecting needs the same authority. Only the requester cancels. Everything is audited.
- **The diff** (`rule-diff.ts`) compares key by key. It reports a rule as:
  - added or ended;
  - ended when only its window closes earlier;
  - changed, with each field before and after;
  - unchanged when only the version differs.
- **The impact** (`rule-impact.ts`):
  - Each locked calculation of the window is unsealed and recalculated with the change in
    force, through the store's new rule-set overlay (`ruleSet`, `overlaid`,
    `resolveAgainst`).
  - It is compared component by component.
  - It also reports documents that would no longer calculate, or that the matrix would no
    longer cover.
  - The defaults are 3 months, at most 12, and 2,000 calculations.
- **The API:**
  - `GET /catalog/packages`, `GET /catalog/packages/:id/diff[?against=]`, `GET /rules`;
  - `GET|POST /rule-changes`, `GET /rule-changes/:id`,
    `POST /rule-changes/:id/approve|reject|cancel`;
  - `GET|POST /delegations`, `POST /delegations/:id/revoke`.

  `rules:approve` belongs to the admin role alone.
- **The CLIs:**
  - `phase82:catalog` has `request-adoption` and `approve`;
  - `tax:scenarios` has `request-adoption` and `approve-adoption`;
  - direct adoption is gone.
- **The web:**
  - `/app/fiscal/rules` has four tabs:
    - requests, with diff, impact and decision;
    - the catalogue, with adoption state, package diff and requests;
    - the workspace's rows, to request a new rule or a retirement;
    - the support matrix.
  - The document's explanation tab shows each component's base, rate, steps, outcome, rule
    and source.
  - The controls screen lends `fiscal:rules:approve`, from Fiscal admins only.

## Proof

- **Unit tests:**
  - Fiscal 239: the diff (added, ended by window, changed, version-only unchanged) and the
    routes (the one segregation-of-duties answer, admin-only requests, role or delegation
    passed to the service, refusals with their status);
  - contracts 164, with the matrix covering six modules and Fiscal lending only its
    approval;
  - web 176: who is offered the decision and the cancellation, and the rate shown as a
    percentage.
- **e2e:** Fiscal 80, of which `governance.e2e-spec.ts` has 5:
  - the requester is refused the approval and the rejection, the database refuses her
    decision on any path, and another admin approves, which adopts. The audit reads
    requested, adopted, approved, with their actors;
  - a second request about the same package is refused while one is pending; only the
    requester cancels;
  - a decision through a delegation records both names. A delegation lent only by the
    requester decides nothing. An issuer lends nothing;
  - an own CBS rate shows, before approval, both locked documents going from 0,90 to 1,20.
    Once approved, the next calculation uses it. Retiring it changes no locked document.
    Withdrawing the package shows both documents losing their classification;
  - the diff: 3 added before adoption, 3 unchanged after it, the law's CBS key replaced
    field by field (priority, scope, window, rate, legal basis), and 3 ended on withdrawal.

  `catalog.e2e-spec.ts` now adopts and withdraws only through request and approval (17).
- **The local stack** ([drill](drills/2026-10-01-phase88-rule-governance.json)):
  - **Golden path workspace:** a request for an own CBS rate recalculated 98 locked
    documents of the last 3 months. 12 normal sales would change (for example 0,23 → 0,30)
    and 86 would stay the same. The requester's approval was refused (`403`,
    `segregation-of-duties`, `fiscal.rules`) and the second admin rejected the request, so
    the rules are unchanged.
  - **A new workspace:** an issuer's request was refused (`403`). An admin's adoption was
    refused to her and approved by another admin, and the diff went from 3 added to 3
    unchanged. An issuer could not lend the approval, and an admin lent it. The audit reads
    requested, adopted, approved, granted.
  - **The screen,** in Chromium with the demo user: the catalogue with its adoption states,
    a package diff and the matrix, with no page error and no Fiscal API error.

## What remains

- **Replacing a workspace rule needs another priority or window.** The store refuses an
  equal scope over an overlapping window, even when the other is retired (Phase 41).
- **The impact report is kept with the request.** It is not recalculated at approval;
  approval checks that the change still applies.
- **Phase 41's `POST /rule-overrides` still records a proposal and nothing more.** A
  replacement goes through `add-rule`.
