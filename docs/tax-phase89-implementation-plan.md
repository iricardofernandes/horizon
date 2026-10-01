# Phase 89 — Threat model, service levels, the golden path, and closing Phase O

Status: **delivered on 2026-10-01** ([evidence](tax-phase89-evidence.md)). Phase O is closed. The last phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O). It closes Phase O against its four exit criteria.

## What is there today

- **Sales lines reach Fiscal without tax facts.** `deriveCalculationInput` sets
  `taxFacts: {}`, so the Phase 85 and 86 rules never apply to a document Sales originates:
  - ICMS for a contributor's resale needs `destinationUse = resale`;
  - IPI needs `ipiTaxpayer = true`, and PIS/Cofins read ICMS.

  So the Ledger's tax posting (Phase 87) is proven only end to end in tests, never on the
  stack.
- **Metrics:** Fiscal measures the authority, the queue, the outbox and the certificates.
  Nothing measures the calculation:
  - no preview latency;
  - no count of `unsupported` answers;
  - no measure of the oracle's agreement, which lives only in `make tax-oracle` and the
    `tax-oracle` CI job;
  - no proof that locked calculations still replay, outside a CLI and the restore drills.
- **2027:** the reform's 2027 rates are not published. Phase 84 proved the engine at
  hypothetical nominal rates and never published that package. The stack's catalogue is
  immutable, so a hypothetical package can never enter it.

## Decisions (taken with the workspace owner on 2026-10-01)

1. **Sales documents carry the facts their parties and items state** (resolved in this
   phase). Fiscal still never infers them:
   - **The customer's fiscal profile (Parties)** gains an optional `goodsDestination`
     (`resale`, `consumption`): what a contributor customer does with the goods it buys.
   - **The item's classification (Catalog)** gains `ipiTaxpayer`: the workspace is an IPI
     taxpayer for this item, because it manufactures it or is equated to an industrial
     establishment. It is part of the classification revision, from its date.
   - **Readiness and the sale estimate** state the line's facts from the revisions they
     already bind:
     - `destinationUse` when the recipient is a contributor and the profile says so;
     - `ipiTaxpayer = true` when the classification says so.

     The readiness binding already names those revisions, so a lock replays as it was.
2. **Service levels** in `infra/observability/rules/phase-o.rules.yml`:

   | SLI | Objective | Alert |
   |---|---|---|
   | Previews answered within 0.5 s | 95% | `TaxPreviewSlow`: below for 10 minutes |
   | Share of `unsupported` answers, by code and kind of missing dimension | watched, no objective | `TaxUnsupportedSurge` (info): over 50% for 30 minutes, with at least 20 answers |
   | Oracle disagreements in the last recorded run | zero | `TaxOracleDisagrees`: any; `TaxOracleStale` (info): no run for 8 days |
   | Locked calculations that fail to replay | zero | `TaxLockReplayFailed`: any in 1 hour |

   - **The oracle:** each `make tax-oracle` run is recorded in Fiscal (cases, differences,
     refusals, digests) by a CLI, and Fiscal exports the last run and its age.
   - **The replay:** the worker replays a sample of recent locks every 10 minutes and counts
     the outcomes.
3. **The Phase O golden path** (`scripts/phase-o-golden-path.mjs`) runs on the stack's
   golden path workspace, with the real 2026 packages. It:
   1. adopts, through request and approval, the packages a resale of NCM 8509.40.10 needs,
      showing each impact report;
   2. quotes with an estimate, orders, delivers and locks the sale;
   3. checks the Ledger's tax postings;
   4. requests the next version, showing its impact;
   5. replays the locked document unchanged.

   It is idempotent across runs.
4. **2027, in isolation** (`scripts/phase-o-2027.mjs`): a throwaway database where the
   hypothetical 2027 package is published, labelled as such, beside the real ones. The same
   operation, dated 2026, 2027, 2029 and 2033, shows the regime of its date. A document
   locked before the next version replays unchanged after it is adopted. The script writes
   its own record.
5. **The threat model** (`docs/phase-o-threat-model.md`) states each threat with its
   control and its proof:
   - a tampered package;
   - oracle drift;
   - a rounding exploit (a property test);
   - a stale adoption;
   - an override without a reason;
   - self-approval;
   - a cross-tenant read;
   - an unsupported scenario reaching the lock.

   `scripts/phase-o-drill.mjs` attacks through Kong and records what held.

## Exit evidence

The four exit criteria of Phase O, each with its record under `docs/drills/`:
1. A rate change is a new package version; documents from its date calculate with it, and
   every lock replays byte for byte: the 2027 record, the golden path and the replay
   sampler.
2. Every supported IBS/CBS/IS scenario matches the official calculator (the recorded
   oracle run). Every supported legacy scenario has an approved fixture, and anything else
   is refused (the drill).
3. The same operation dated 2026, 2027, 2029 and 2033 shows its date's regime, citing each
   rule version and source: the 2027 record.
4. Sales and Procurement show estimates, and the lock is the only amount in the books: the
   golden path.
