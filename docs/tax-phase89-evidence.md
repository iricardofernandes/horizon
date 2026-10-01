# Phase 89 evidence — Threat model, service levels, the golden path, and closing Phase O

[Plan](tax-phase89-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[Threat model](phase-o-threat-model.md) · [Service levels](service-levels.md#phase-o--the-tax-engine)

Phase O is closed.

## What was delivered

- **Sales documents carry the facts their parties and items state.**
  - **Parties:** a customer's fiscal profile has an optional `goodsDestination`
    (`resale`, `consumption`), stated only for an ICMS contributor. Profiles described
    before it read as unstated.
  - **Catalog:** the item's classification has `ipiTaxpayer`, with its own revision and
    date (migration `0006`). A later revision that does not say it keeps the previous value.
    The classification event carries it (contracts 0.63.0, additive).
  - **Fiscal:** the facts are projected, with `catalog_classifications.ipi_taxpayer`
    (migration `0061`) and the party export's `goodsDestination`.
    - Readiness and the sale estimate state `destinationUse` and `ipiTaxpayer` from the
      revisions readiness already binds (`lineFacts`).
    - What an estimate request states adds to them.
- **A defect from Phase 87, fixed.** The outbox relay read `occurredAt` from
  `payload.observedAt`, and `fiscal.calculation.locked` has none.
  - Publishing it threw, the flush rolled back, and the first lock stopped every later
    Fiscal event of its workspace.
  - On the stack, 5 lock events and 4 others were stuck. No lock had ever reached the
    Ledger: Phase 87's drill checked the outbox, not the delivery.
  - The relay now uses the commit time when the payload states none. The 9 events were
    delivered on redeploy.
- **Service levels** (`phase-o.rules.yml` with promtool tests, `docs/service-levels.md`,
  the *Horizon — Phase O* dashboard):
  - **The measures:**
    - `fiscal_tax_calculation_seconds{operation}`, in seconds from 5 ms to 10 s;
    - `fiscal_tax_answers_total{operation, outcome, code, dimension}`, where the dimension
      is a kind, never a value;
    - `fiscal_tax_lock_replays_total{outcome}`, from a worker sampler that replays 10
      random locks of the last 30 days per workspace every 10 minutes;
    - the last recorded oracle run's disagreements, refusals, lines and age
      (`fiscal_tax_oracle_runs`, migration `0062`).
  - **Recording oracle runs:** `tax:oracle-record`, or `scripts/tax-oracle.mjs --record-by`.
  - **The alerts:** `TaxPreviewSlow`, `TaxUnsupportedSurge` (info), `TaxOracleDisagrees`,
    `TaxOracleStale` (info) and `TaxLockReplayFailed`.
- **The threat model** names eight threats, each with its control and its proof.
  `rounding.property.spec.ts` checks the rounding exploit over 300 seeded documents.
- **The scripts:**
  - `scripts/phase-o-golden-path.mjs` (`make phase-o-golden-path`);
  - `scripts/phase-o-drill.mjs` (`make phase-o-drill`);
  - `scripts/phase-o-2027.mjs` (`make phase-o-2027`), with `phase89-isolated-cli`. It
    refuses any database but `horizon_phase89_isolated`, because only there may a
    hypothetical package be published.
- **`reviewed-packages.ts`** builds the Phase 85 and 86 packages for both `tax:scenarios`
  and the isolated run.

## The four exit criteria of Phase O

1. **A rate change is a new package version.** Documents dated from its effective date
   calculate with it, and every lock replays byte for byte.
   - **The isolated record** ([2027](drills/2026-10-01-phase89-isolated-2027.json)):
     - after the hypothetical 2027 package was adopted, the same operation in 2027 shows
       CBS at 22/625 (3.52%, class 200030) where 2026 shows 9/2500;
     - the impact report on the document locked on 2026-12-30 said 1 examined, 0
       changed, and that document replayed byte for byte after the adoption.
   - **The golden path** ([record](drills/2026-10-01-phase89-golden-path.json)): the
     official 2026 package, requested as the next version, showed 0 of 100 locked
     documents changing, and was approved by the second admin. The lock replayed with the
     same digest.
   - **The stack's sampler** reproduced 10 of 10 locks (`fiscal_tax_lock_replays_total`).
2. **Every supported IBS/CBS scenario matches the official calculator, and anything else
   is refused.**
   - The oracle runs are recorded in Fiscal: `sli:tax_oracle_disagreements:max` is 0 for
     2026 and for the hypothetical 2027 (6,104 of 6,104 lines in Phase 84).
   - Every supported legacy scenario has a fixture the workspace owner approved (Phases 85
     and 86; the matrix is unchanged at 79 rows).
   - **The drill** ([record](drills/2026-10-01-phase89-drill.json)): an unreviewed
     interstate scenario answered `422 UNSUPPORTED_RULE`. In the isolated run, a 2027 lock
     with ICMS, which no fixture approves, was refused with `UNSUPPORTED_SCENARIO`.
3. **The same operation dated 2026, 2027, 2029 and 2033 shows the regime of its date,**
   citing each rule version and source (the isolated record). The operation is a Lucro
   Real resale of NCM 8509.40.10, SP → SP, to a contributor:

   | Date | Legacy side | IBS/CBS (class 200030) |
   |---|---|---|
   | 2026-10-15 | ICMS 68,36 (18%), PIS 5,14, Cofins 23,67 | CBS 1,37, IBS UF 0,15 (official 2026) |
   | 2027-03-15 | ICMS 68,36; PIS/Cofins end | CBS 13,37, IBS 0,08 + 0,08 (hypothetical) |
   | 2029-03-15 | ICMS 61,53 (9/10 of 18%, EC 132 art. 128) | unsupported: no rates published |
   | 2033-03-15 | unsupported: ICMS no longer exists | unsupported: no rates published |

4. **Sales and Procurement show estimates, and the lock is the only amount in the books.**
   This is the golden path on the stack's golden path workspace:
   - two packages were adopted through a request and another admin's approval, each with
     an impact report of 0 changed and 0 unsupported;
   - an item classified as not an IPI taxpayer, and a contributor customer whose profile
     says it resells;
   - the quote's estimate (ICMS 68,36, PIS 5,14, Cofins 23,67, CBS 3,42, IBS UF 0,38) was
     kept on the quote and carried to the order;
   - after the delivery, the locked calculation equals the estimate;
   - the Ledger posted 97,17 from the lock: 4.05 debit, 2.02 credit, for each of ICMS, PIS
     and Cofins.

## Proof

- **Unit tests:**
  - Fiscal 246: the line facts from profiles, the rounding property, the metrics and
    their dimension kinds, the oracle report, the replay sampler, the relay's
    `occurredAt`;
  - Parties 77, Catalog 92, contracts 164, web 176.
- **e2e:**
  - Fiscal 80, including the classification's `ipiTaxpayer`, projected and refused on
    conflict, and read as false for a revision published before it;
  - Catalog 43, including a revision that keeps it and the events that carry it.
- **promtool:** `make test-alerts` passes with `phase-o.rules.yml` and its 6 tests.
- **The stack:**
  - the golden path, run three times;
  - the drill, 15 of 15 held:
    - a change without a reason, by either door;
    - an own rule at the catalogue's precedence;
    - an issuer asking, a viewer approving, an issuer lending;
    - self-approval and self-rejection (`segregation-of-duties`);
    - another admin cancelling;
    - a cross-tenant read and list;
    - an unreviewed scenario;
    - the application writing the catalogue (`42501`);
  - the Phase 45 smoke still issues, with the packages adopted;
  - the Phase O SLIs evaluate in Prometheus: 0 failed replays, 0 disagreements, 100% of
    previews under half a second, 0 unsupported.

## What remains

- **No screen states the facts yet.** A customer's fiscal profile and an item's
  classification are set through their APIs, as before this phase.
- **Rates from 2027 are hypothetical** until the Senate fixes them. The 2027 package is
  proven only in isolation and never published, and from 2029 IBS/CBS answer `unsupported`.
- **The Phase 45 smoke needed stock.** Orders confirmed by earlier demos and browser runs
  held the item's stock, so the drill received 30 units through a purchase before
  re-running it.
