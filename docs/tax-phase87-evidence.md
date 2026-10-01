# Phase 87 evidence — Taxes where money is decided

[Plan](tax-phase87-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[ADR 0073](adr/0073-tax-estimates-outside-fiscal-amounts-inside-it.md) ·
[ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md) ·
[Drill](drills/2026-10-01-phase87-estimates-rollout.json)

## What was delivered

- **Contracts 0.60.0 and 0.61.0, additive.** The compatibility gate found no breaking
  change.
  - `fiscalTaxEstimateRequestSchema`: a sale (customer) or a purchase (supplier, with the
    supplier's regime stated) of lines with a price, an optional discount, facts and
    `classTrib`.
  - `fiscalTaxEstimateSchema`: supported with components, totals (`net`, `tax`,
    `chargedOnTop`, `gross`) and the three digests; or refused with the code and the missing
    dimension. `FISCAL_TAXES_CHARGED_ON_TOP` is IPI, ICMS-ST and FCP-ST.
  - `fiscal.calculation.locked` v1: origin, purpose, model, environment, each component
    (group, code, signed amount, outcome), the totals and the digests, never the rules.
  - `procurement.order.approved` gains an optional `taxEstimate` (the digest form).
  - The reconciliation's comparison gains an optional `taxes` block.
  - Support matrix rows gain `operation` and `purpose`, and their classification may be
    absent. The evidence kind `approved-scenario` and the problem code
    `UNSUPPORTED_SCENARIO` are added.
- **Fiscal:**
  - `POST /fiscal/estimates` (`estimates.ts`).
    - A sale is derived by readiness's own `deriveCalculationInput`, so the estimate and the
      later lock agree.
    - A purchase makes the supplier the issuer of the reviewed normal sale, with the regime
      the caller stated. Fiscal never infers it.
    - Anything the matrix does not cover is refused, as the lock would refuse it.
  - **The lock enforces the matrix** (`scenarioSupport`) inside its transaction, and refuses
    with `UNSUPPORTED_SCENARIO` naming what is missing. The draft stays a draft.
    - The approved scenarios of Phases 41, 43, 45, 46 and 47 joined the matrix as eight
      operation-scoped rows (`approved-scenarios.ts`), cited by their evidence records and
      digests. The matrix now has 79 rows.
  - **Every lock writes `fiscal.calculation.locked`** to the outbox in the same transaction.
  - **Purchase estimates are projected** from `procurement.order.approved` into
    `fiscal_purchase_order_estimates` (migration `0059`, immutable, forced RLS).
  - **The Phase 44 reconciliation compares taxes.** When the NF-e is reconciled against one
    order that kept an estimate, it compares ICMS, ICMS-ST, IPI, PIS and Cofins, and names
    each difference.
    - The comparison is informative: the estimate never binds the supplier, so it neither
      blocks the match nor asks for an override.
- **Sales** keeps the estimate on quotes and orders (`tax_estimates`, migration `0019`).
  - `GET`/`PUT /sales/quotes/:id/tax-estimate` and `/sales/orders/:id/tax-estimate`.
  - Recording is accepted while the document is open (a quote in draft, pending or sent; an
    order in draft or placed), and refused with 409 afterwards.
  - Converting a quote carries its estimate to the order with its digests.
  - The receivable is still posted at dispatch.
- **Procurement:**
  - `PUT /procurement/orders/:id/tax-estimate` on a draft order. The taxes charged on top
    replace the typed `tax`, and the lines are repriced.
  - A revision clears the estimate.
  - The approved event carries it (migration `0005`, with its column grant).
  - The order detail returns it.
- **Ledger** posts the taxes contained in the price from `fiscal.calculation.locked`.
  - It debits `sales-taxes` (an expense) and credits `taxes-payable` (a liability), keyed by
    component. Both roles are new (migration `0006`, source `tax-lock`).
  - It posts ICMS, PIS, Cofins, ISS, ICMS DIFAL and FCP DIFAL when levied and non-zero.
  - It posts only Sales origins outside homologation, once per origin and purpose. A
    redelivery or a corrected revision posts nothing more, and a return's lock reverses.
  - Left out, as decided: IPI, purchase credits, and the CBS/IBS of 2026.
  - An unmapped role falls back to suspense, as every other posting does. The demo chart maps
    both roles (2.02 Impostos a recolher, 4.05 Impostos sobre vendas).
- **Web:** `TaxEstimatePanel`, labeled as an estimate, on the quote dialog (goods lines), the
  sales order details (read only), and the purchase order dialog. The purchase panel has a
  select for the supplier's regime, and is live while the order is a draft.

## Proof

- **Unit tests:**
  - Fiscal 233, new ones:
    - estimates: a sale derived as readiness derives it, a refusal naming what is missing,
      and a purchase that requires the supplier's regime;
    - the tax comparison;
    - `scenarioSupport`.
  - Sales 129, Procurement 53, Ledger 50, contracts 164, web 173.
- **e2e:**
  - **Fiscal** (`catalog.e2e-spec.ts`):
    - G4 locks and publishes ICMS 68,36, Cofins 23,67 and PIS 5,14;
    - a contributor's own-use purchase, where only IPI is calculated, is refused with
      `UNSUPPORTED_SCENARIO` naming IPI, and the draft stays a draft.
  - **Fiscal** (`phase44-inbound.e2e-spec.ts`): the supplier XML states no ICMS against an
    estimate of 7,20. The value matches, and the taxes show −7,20 ICMS and −0,99 PIS.
  - **Sales** (`database.e2e-spec.ts`): the estimate is recorded on the open quote, refused
    on an unknown one, frozen once accepted, and carried to the order with its digests.
  - **Procurement** (`procurement.e2e-spec.ts`): the typed 50,00 is replaced by the IPI
    charged on top (total 404,49). The approved event validates against the contract and
    carries the estimate. A committed order refuses a new one.
  - **Ledger** (`postings.e2e-spec.ts`):
    - ICMS and PIS are posted per component and IPI and CBS are left out;
    - a redelivery and a corrected revision post nothing more;
    - a return reverses ICMS;
    - manual, homologation and CBS-only locks post nothing.
- **The local stack** ([drill](drills/2026-10-01-phase87-estimates-rollout.json)):
  - The Phase 45 smoke issued the sale, its return, the purchase return and the value
    complement with the matrix enforced. Each lock published its event, and Ledger posted
    none of them, as CBS/IBS of 2026 are not posted.
  - A quote's estimate (CBS 0,23, IBS UF 0,03) was kept, refused once the quote was
    accepted (409), and the order kept its digests.
  - A purchase estimate for a stated Lucro Real supplier replaced the typed 5,00 with the
    0,00 charged on top, and the order kept its digest.
  - The Phase 41, 85 (7 of 7) and 86 (8 of 8) verifications still match. The Phase 41
    digests are unchanged.

## What the stack did not show

- **A Sales lock carrying ICMS, PIS or Cofins.** No local workspace both issues from Sales
  and has the Phase 85/86 packages adopted. The posting is proven by the Ledger e2e.
- **A supplier XML with a different ICMS.** The local test supplier states no legacy tax,
  and the golden path estimate has none. The difference is proven by the Phase 44 e2e.
- **The purchase estimate is for intrastate purchases only.** It uses the reviewed normal
  sale, which is SP → SP. An interstate purchase is refused until its operation is reviewed.
