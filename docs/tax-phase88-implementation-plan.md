# Phase 88 — Governing the rules

Status: **delivered on 2026-10-01** ([evidence](tax-phase88-evidence.md)). The seventh phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O). It implements [ADR 0074](adr/0074-a-tax-rule-change-is-requested-and-approved-by-another-person.md),
revises [ADR 0070](adr/0070-tax-law-is-a-shared-catalogue-that-workspaces-adopt.md), and adds
Fiscal's pair to [ADR 0062](adr/0062-segregation-of-duties-is-a-declared-matrix.md)'s matrix.

## What is there today

- **The catalogue** (Phase 82) is read-only to the application.
  - A workspace adopts or withdraws a package only through a CLI, by one person, with no
    request and no approval.
  - Nothing shows what a package changes against what the workspace already has.
- **A workspace's own rows** come from per-tenant source packages, imported, reviewed and
  activated through rollout CLIs (Phases 41–47).
  - `POST /fiscal/rule-overrides` records a proposal, which nothing approves.
- **The screens:**
  - documents, with an explanation tab that prints the explanation text;
  - the support overview.
  - There is no screen for the catalogue, the adoptions, the workspace's rows or the
    matrix.
- **Fiscal has no pair in ADR 0062's matrix,** and no delegations.

## Decisions (taken with the workspace owner on 2026-10-01)

1. **Every change to the rules a workspace calculates with is a request another person
   approves.** There are four kinds:
   - adopt a catalogue package, from a date;
   - withdraw an adopted package;
   - add a workspace rule (a full definition, scoped by establishment, item, party or
     operation, with its legal basis);
   - retire an active workspace rule.

   How a request moves:
   - **Requesting:** a Fiscal admin (`rules:manage`) requests.
   - **Deciding:** another Fiscal admin approves or rejects (`rules:approve`, held only by
     the admin role). Whoever requested never decides, either way, even through a
     delegation. The refusal is `segregation-of-duties` with the pair `fiscal.rules`.
   - **Cancelling:** the requester may cancel while the request is pending.
   - **Applying:** approval applies the change in the same transaction, after checking that
     it still applies (the package is still not adopted, no tie with an active rule, the
     rule is still active).
   - **Auditing:** every request, decision and cancellation is audited.
2. **Fiscal joins ADR 0062's matrix with delegation.**
   - The pair: `fiscal:rules:request` / `fiscal:rules:approve`.
   - Delegation: `/fiscal/delegations`, with the same contract and limits as the other
     modules. A decision through a delegation records both names.
3. **The CLI goes through the same path.**
   - `phase82:catalog` and `tax:scenarios` replace `adopt` with `request` and `approve`,
     whose actors must differ.
   - Direct adoption no longer exists outside the approval.
4. **Impact before approval.**
   - When a request is made, Fiscal recalculates the workspace's locked calculations of the
     last N months (default 3, at most 12), without locking.
   - Each recalculation uses the rules as they would be with the change in force over the
     whole window, so a future-dated adoption still shows what it would change.
   - The report lists every document whose amounts would change, component by component,
     with what it had and what it would have. It also lists every document that would no
     longer calculate, or that the support matrix would no longer cover.
   - The report keeps its digest and is shown with the request. The approver decides on it.
   - At most 2,000 calculations are read, newest first; a larger window says it was cut.
5. **The diff.** A package is compared by `ruleKey` with the rules the workspace has today
   (adopted and its own), or with another package. Each rule is reported as:
   - added (a key the other side lacks);
   - ended (a window that now closes earlier, or a rule only on the other side);
   - changed (the fields that differ, before and after);
   - unchanged.
6. **The screens** (`/app/fiscal/rules`):
   - the catalogue by package, with its adoption state and the diff;
   - the workspace's own rows;
   - the requests, with their diff and impact, and the decisions;
   - the support matrix.

   The document's explanation tab shows each component's base, rate, steps, outcome, rule
   and source.

## Contracts (one additive release)

- **Catalogue and diff:** `fiscalCatalogPackageSchema` and `fiscalRuleDiffSchema`.
- **Rule changes:** `fiscalRuleChangeRequestSchema` (the four kinds),
  `fiscalRuleChangeSchema` (the request, its impact and its decision), and
  `fiscalRuleImpactSchema`.
- **The ADR 0062 matrix** gains `fiscal.rules`.

## Exit evidence

- An adoption requested by one person is refused to them and approved by another.
- The impact report lists every document whose amounts would change.
- The diff shows each rule added, ended or changed.
