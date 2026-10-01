# Phase 87 — Taxes where money is decided

Status: **delivered on 2026-10-01** ([evidence](tax-phase87-evidence.md)). The sixth phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O). It implements [ADR 0073](adr/0073-tax-estimates-outside-fiscal-amounts-inside-it.md)
(estimates outside Fiscal, amounts inside it) and enforces
[ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md) at the lock.

## What is there today

- **Sales:**
  - quotes and orders carry no tax;
  - the receivable is posted at dispatch for the goods (ADR 0048);
  - Fiscal builds a document's calculation input from the shipment in readiness, from the
    issuer profile in force on the issue date, the customer's profile and each item's NCM.
- **Procurement:**
  - a purchase order has one typed `tax`, added on top of the goods;
  - the supplier XML is parsed with its tax totals and per-line taxes;
  - the Phase 44 reconciliation compares only values.
- **Ledger** posts from Financial and Treasury facts by fixed rules over posting roles. It
  reads nothing from Fiscal.
- **Modules never call one another.** They exchange events; the web orchestrates HTTP
  across them.

## Decisions (taken with the workspace owner on 2026-10-01)

1. **An estimate is Fiscal's calculation of a draft, never locked.** `POST /fiscal/estimates`
   takes a commercial draft and returns a summary: supported or the missing dimension; each
   component with its amount and outcome; the totals; the three digests.
   - A sale draft: the workspace issues to the customer. The input is derived exactly as
     readiness derives it for a shipment, so an estimate and the later lock agree.
   - A purchase draft: the supplier issues to the workspace. The supplier's regime and each
     line's facts must be stated by the caller, because Fiscal holds no supplier regime and
     never infers a treatment.
2. **Sales keeps the estimate on the quote and the order.** The web asks Fiscal and hands
   the summary to Sales. Sales shows it labeled as an estimate, with the gross total, and
   keeps the digests. The receivable is posted at dispatch as today.
3. **Procurement keeps the estimate on a draft purchase order.** Its taxes charged on top
   (IPI, ICMS-ST) replace the typed `tax`. The approved order's event carries the estimate,
   so Fiscal's reconciliation compares the supplier XML with it, component by component,
   and names each difference.
4. **A lock publishes `fiscal.calculation.locked`,** with each component (code, group,
   amount, outcome), the totals and the digests, never the rules.
5. **Ledger posts the taxes contained in the price, per component, from the lock:**
   - debit the `sales-taxes` role (an expense, deducted from revenue) and credit the
     `taxes-payable` role (a liability), each keyed by component;
   - for ICMS, PIS, Cofins, ISS, DIFAL and FCP, when levied and non-zero;
   - a return's lock carries negative amounts and posts the reversal;
   - posting is idempotent by document and component, so replaying the events reproduces
     the balances;
   - left out, stated:
     - IPI, charged on top, which would change the receivable, owned by the dispatch;
     - purchase credits, whose source (the supplier XML) is evidence, not a fact (ADR 0051);
     - CBS/IBS of 2026, whose payment is waived when the obligations are met (LC 214
       art. 348 §1º).
6. **The lock refuses a scenario outside the support matrix** (`UNSUPPORTED_SCENARIO`).
   - A line is supported when every component calculated for it is covered by a matrix row
     that admits the line, and every such row's taxes were all calculated.
   - The approved scenarios of Phases 41, 45, 46 and 47 join the matrix as rows scoped by
     operation, with their evidence records. So the documents the platform issues today stay
     supported.

## Contracts (one additive release)

- **Estimates:** `fiscalTaxEstimateRequestSchema` and `fiscalTaxEstimateSchema` (the
  summary).
- **The event:** `fiscal.calculation.locked` v1.
- **Support matrix rows:**
  - optional `operation` and `purpose`, and an optional classification (absent means any);
  - evidence kind `approved-scenario`;
  - the problem code `UNSUPPORTED_SCENARIO`.
- **Sales and Procurement:**
  - the estimate summary on quotes, orders and purchase orders;
  - the optional estimate on `procurement.order.approved`.

## Exit evidence

- A quote shows its estimate, and the confirmed order keeps the digests.
- A supplier XML with a different ICMS shows the difference on the reconciliation.
- A locked document posts its tax components, and replaying the ledger produces the same
  balances.
- A lock outside the matrix is refused, naming what is missing. The golden path still
  issues.
