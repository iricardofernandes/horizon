# Services threat model

Scope: service orders, contracts, billing runs and credits in `sales/`, and their effects
in `financial/` and `fiscal/`, as delivered through Phase 53
([ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md)). The NFS-e is
issued in simulation only (see the [Fiscal threat model](fiscal-threat-model.md)). Each row
names the control and the test or evidence that proves it. A threat without a test is
listed as open.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Service orders and deliveries | `service_orders`, `service_deliveries` and their lines | A delivery is money owed and a fiscal document |
| Contracts and revisions | `service_contracts`, `service_contract_revisions` and lines, suspensions | What every future period will bill |
| Billed periods | `contract_billed_periods` and lines | Frozen facts that Financial and Fiscal act on |
| Billing runs | `contract_billing_runs`, `contract_billing_run_items` | The record of what a month billed and refused |
| Service events | Sales outbox: `sales.service.*`, `sales.contract.*`, `sales.contract-period.*` | They raise receivables and NFS-e |
| Effects followed by Sales | `service_delivery_effects`, `service_delivery_line_nfse`, the effect columns of billed periods | What an operator reads to know what is missing |

## Trust boundaries

1. **Browser → web → Kong → Sales.** The session cookie becomes a short EdDSA token. Sales
   checks it and reads the `sales` role:
   - `read` for viewers;
   - `manage` for representatives and admins.
2. **Sales → broker → Financial and Fiscal.** Owner events only (ADR 0048). Sales never
   calls either module; it follows their events back.
3. **Sales → database.** One role per module, RLS forced on every business table. The relay
   role reads the outbox and only the counting columns of billed periods.

## Threats and controls

| Threat | Control | Proof |
|---|---|---|
| A tenant reads or changes another tenant's orders, contracts, runs or billed periods | RLS forced on every new table; tenant from the verified token only | Sales e2e: cross-tenant reads and writes on service orders, contracts, billed periods, runs and delivery effects; restore check: another tenant sees nothing |
| A period is billed twice (retry, re-run, crash, replay) | Unique `(contract, competence)`; runs under an idempotency key, resumable, one transaction per contract under its lock; consumers key the title by billed period and the intake by entry | Sales e2e (stopped run resumed, new run, unique violation); Financial and Fiscal e2e (replay); Phase 52 smoke and Phase 53 golden path (same key, new key, replay under a new event id) |
| A billed period, a revision or a delivery is rewritten | Insert-only grants on revisions and billed lines; triggers on billed periods, run items, deliveries and suspensions | Sales e2e; restore check proves the guards survive a restore |
| A change reaches back into a billed or begun period | The domain accepts a change only at a future, unbilled period start | Domain tests; golden path: an amendment at a billed month answers 409 |
| A credit loses the period it corrects | A credit only marks the period; its facts stay, and it is never billed again | Domain and e2e tests; golden path and browser workflow show the period kept and credited |
| A role does more than it may | `RequireSalesAction` on every route; the screens hide actions a role cannot take | `authorization.spec.ts`: a viewer reads but cannot bill, credit, run or amend; another module's role and a forged token are refused |
| A cross-tenant count leaks through the metrics | Gauges read only counting columns through the relay; labels are outcomes and reasons, never tenants or customers (ADR 0055) | Sales e2e: the relay is refused `tenant_id`, amounts and runs; metric label review |
| A refused contract goes unnoticed | Every refusal is a run item with its reason; `SalesBillingRefusals` alert | Unit tests; smoke; promtool tests |
| A billed period never reaches Financial or Fiscal | Sales follows both owners' events and reports gaps past a threshold; alerts on gaps and blocked intakes | Sales e2e (projections and gaps); promtool tests; overview read |
| A link carries another tenant's record | Links carry ids only; the target screen reads through the same tenant-scoped API | Deep-link reads use the tenant's own lists |
| A person reads a draft receivable as posted | The screens show the state Financial reported: draft, posted, reversed or withdrawn | `receivableState` spec; browser workflow |

## Open items

- **Scheduler.** Runs start through the API or the screen; nothing bills a month by itself.
- **Partial credits and substitution (105102).** A correction is a whole-period credit.
- **Rate limits** on run starts rely on Kong's route limits; a run's size is bounded by the
  tenant's contracts, and a timed-out run is resumed under the same key.
