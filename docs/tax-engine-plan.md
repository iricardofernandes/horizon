# Tax rules engine implementation plan — Phase O

Status: **in progress** — Phases 82 to 85 delivered on 2026-09-30 and 86 on 2026-10-01 ([82](tax-phase82-evidence.md), [83](tax-phase83-evidence.md), [84](tax-phase84-evidence.md), [85](tax-phase85-evidence.md), [86](tax-phase86-evidence.md)). This is the execution plan for Phase O,
split into phases 82–89 of [plan.md](plan.md). Each numbered phase gets its own detailed
plan before implementation, one local commit and an evidence record, as in Phases J to N
and 79 to 81.

## Outcome and boundaries

Phase J built a fiscal context that can explain a calculation and replay it exactly
(Phase 41), but it approved **one** scenario: an intrastate sale in São Paulo in 2026, with
CBS at 9/1000 and IBS at 1/1000. Every other scenario answers `unsupported`. Phase O turns
that core into the engine the [roadmap](roadmap.md#fiscal--a-versioned-multi-regime-tax-rules-engine)
describes:

> A rules engine that evaluates versioned, temporally scoped, jurisdiction-scoped rule
> sets, where two independent rule sets are simultaneously in force during a multi-year
> transition, and where a historical document must be recalculable exactly as it was
> calculated on its original date.

After Phase O:
- **Tax law is data, shared by every workspace.** A rate change is a new version of a
  published rule package, never a deployment and never a copy per tenant. A workspace
  adopts versions, and adds only what is its own (a special regime, a court decision).
- **Formulas are declarative:**
  - composed bases;
  - gross-up (base "por dentro");
  - base reductions;
  - deferral, exemption and suspension;
  - tax on tax, in a declared order.

  One pure interpreter evaluates them, and its explanation shows every step.
- **IBS, CBS and the Imposto Seletivo follow the reform's schedule from 2026 to 2033,**
  and every supported scenario agrees with the official calculator.
- **The taxes that still exist during the transition are supported where a reviewed
  fixture proves them.** These are ICMS (own, DIFAL, FCP and ST), IPI, PIS/Cofins and ISS.
  The support matrix names each scenario, and everything else stays `unsupported`.
- **Tax is visible where money is decided,** as an estimate labeled as such: the quote,
  the order, the purchase order, the payable. Only a Fiscal calculation lock is
  authoritative.

The four exit criteria of Phase O:
1. **A rate change is a new package version.**
   - Documents dated from its effective date calculate with it.
   - Every locked document replays byte for byte under the version it was locked with.
2. **Every supported IBS/CBS/IS scenario matches the official calculator** across the
   scenario corpus, with zero differences. Every supported legacy-tax scenario has a
   fixture reviewed by the workspace owner (as in Phase 41). Anything else is
   `unsupported` with an explicit code, and cannot be transmitted.
3. **The same operation, dated 2026, 2027, 2029 and 2033,** shows the regime blend of its
   date from the same packages. Its explanation cites each rule version and its source.
4. **Sales and Procurement show taxes before a document exists,** labeled as estimates,
   and the Fiscal lock is the only amount that reaches the books.

Out of scope, and stated so:
- **Tax filing and payment:**
  - apuração;
  - guides (DARF, GNRE, DAS);
  - SPED;
  - the split payment settlement flow.

  Phase O calculates what a document owes, not what the company pays at month's end.
- **Real authority transmission.** Phase J's capability matrix and homologation gates
  still decide what may be transmitted. Phase O changes how amounts are computed, not
  whether a document may be issued.
- **Every state's ICMS-ST and every municipality's ISS.** The support matrix grows one
  reviewed scenario at a time.
- **Tax advice.** A scenario is supported because a source says so and a reviewer approved
  its fixture, not because the engine infers it.
- **CT-e, MDF-e** and the remaining exclusions of Phase J.

## What already exists

| Need | Where it is today |
|---|---|
| Temporal rules with precedence | `fiscal/src/rules.ts`: operation > establishment > item > party > default, then priority. Overlaps of equal priority are refused (Phase 41) |
| Exact arithmetic | `exact-decimal.ts`: rationals, half-away-from-zero rounding, no floating point |
| A calculation that replays | `calculation.ts` and `calculations.ts`: canonical input, rules and result digests, the document lock, replay under the locked version |
| An explanation | `fiscal-explanation-v1`: rule ids, versions, source package, digest and section per component |
| Provenance | `fiscal_source_packages`, `fiscal_source_artifacts`, `fiscal_package_reviews` (append-only, with the reviewer) |
| Reference tables | `fiscal_reference_entries`: CFOP, NCM, CEST, CST, CSOSN, IBS/CBS classes and services, with windows |
| The official calculator | `calculadora.zip` (Receita Federal/SERPRO, database V0057) pinned by digest in the [Phase 41 source manifest](fiscal-phase41-source-manifest.json), with its backend and Simples Nacional sources |
| Fiscal facts | Party and company fiscal profiles, and catalogue NCM and classification events (ADR 0049) |
| Previews | `POST /fiscal/calculations/preview`, which can never transmit |

Gaps:
- **Every row is per tenant.** Source packages, reference entries and tax rules carry a
  `tenant_id`, so a second workspace would import and approve its own copy of the law.
- **The only formula is "rate times net"** (`LINE_NET_TIMES_RATE` and its document and
  return variants). Nothing composes a base, grosses one up, reduces it, or taxes a tax.
- **One approved scenario.** The legacy component group exists and is empty.
- **The official calculator was read once,** to build one fixture. It is not an oracle
  that the rules are checked against.
- **Nothing outside Fiscal sees a tax.**
  - Sales totals have none.
  - Procurement receives the order's tax as one amount a person types.
  - Financial raises the gross amount it is told.

## The reform, as the engine must represent it

Confirmed in Phase 82's source matrix against EC 132/2023, LC 214/2025, and the official
calculator's database and technical notes. Every number becomes a rule row with its
source, never a constant in code. The expected shape:

| Period | IBS / CBS | Taxes being replaced |
|---|---|---|
| 2026 | Test rates: CBS 0.9%, IBS 0.1%, offset against PIS/Cofins | All in force |
| 2027–2028 | CBS at its full rate; IBS at a test rate; the Imposto Seletivo begins | PIS/Cofins end; IPI zero except for goods also made in the Manaus free zone; ICMS and ISS in force |
| 2029–2032 | IBS rises as ICMS and ISS fall to 90%, 80%, 70% and 60% of their rates | ICMS and ISS reduced |
| 2033 | IBS and CBS in full | ICMS and ISS end |

Throughout, the engine also has to handle:
- reduced-rate regimes (60% and 30% reductions, zero rate) keyed by tax classification
  (`cClassTrib`);
- the Simples Nacional option to collect IBS/CBS inside or outside the regime;
- destination-based IBS for interstate operations.

## Decisions to take first (Phase 82)

ADRs 0070–0073:

1. **ADR 0070 — Tax law is a shared catalogue, and workspaces adopt it.**
   - Published rule packages live outside any tenant, each version immutable and digested.
   - A workspace adopts a package version with an effective date, and may add its own rows
     only at `establishment`, `item`, `party` or `operation` precedence (a special regime,
     a court decision, a local agreement).
   - Phase 41's per-tenant package becomes the catalogue's first version. Its locked
     document replays unchanged.
2. **ADR 0071 — Formulas are data over a closed vocabulary.**
   - A component's formula is an expression tree over named bases (net, freight,
     insurance, other expenses, discount, other components), rates as rationals, and five
     operations: sum, product, gross-up, reduction and minimum/maximum.
   - Outcomes other than an amount (exempt, suspended, deferred, not levied) are values,
     not errors.
   - Components depend on each other in a declared order. A cycle refuses the package when
     it is published, never when a document is calculated.
   - There is no user code, no `eval` and no loop.
3. **ADR 0072 — A scenario is supported only with evidence.**
   - IBS, CBS and IS scenarios are supported when the official calculator, pinned by
     digest, agrees on every corpus case.
   - Legacy-tax scenarios are supported when the workspace owner approved their fixture,
     as in Phase 41.
   - The support matrix is generated from that evidence, not written by hand.
4. **ADR 0073 — Estimates outside Fiscal, amounts inside it.**
   - Sales and Procurement ask Fiscal for a preview and label it an estimate.
   - A preview never locks.
   - Only a document's Fiscal lock reaches Financial and Ledger as tax amounts.

## Phases

### 82 — Decisions, the reform's source matrix, and a shared catalogue

**Delivered on 2026-09-30** ([plan](tax-phase82-implementation-plan.md), [evidence](tax-phase82-evidence.md)).
The sources confirmed the transition. They also showed that the full CBS/IBS rates from
2027 are not yet published, and that the official calculator moved from V0057 to V0059
during the phase.

**Work**
1. ADRs 0070–0073, indexed in `docs/adr/README.md`.
2. **The source matrix** (`docs/tax-phase82-source-matrix.md` and a JSON manifest, as in
   Phase 39):
   - the constitutional amendment and the complementary law;
   - the official calculator (current version, pinned);
   - the NF-e technical notes for IBS/CBS/IS fields;
   - the TIPI;
   - the Confaz agreements used by Phase 85's scenarios.

   Each source has a digest, a retrieval date and the sections used.
3. **The catalogue:**
   - `fiscal_catalog_packages`, `fiscal_catalog_rules` and `fiscal_catalog_references`,
     global and append-only, with a publisher and a digest;
   - `fiscal_package_adoptions` per tenant (version, effective date, adopting actor);
   - resolution reads the adopted catalogue rows and the tenant's own rows, with Phase 41's
     precedence.
4. **Migration:**
   - Phase 41's package becomes catalogue version 1, adopted by the demo workspace;
   - its locked document replays with the same three digests.

**Exit evidence**
- Two workspaces adopt the same package and calculate identically, and neither can write
  to the catalogue.
- The Phase 41 golden fixture replays byte for byte.
- An unadopted package is never used.

### 83 — The formula language and its interpreter

**Delivered on 2026-09-30** ([plan](tax-phase83-implementation-plan.md), [evidence](tax-phase83-evidence.md)).
An expression builds the base, and the rule's rate applies to it. Contracts went to 0.53.0
for the optional `outcome` and `steps`.

**Work**
1. **The expression schema in contracts:**
   - versioned, with the closed vocabulary of ADR 0071;
   - `fiscal-explanation-v2`, which records every intermediate value.

   `v1` explanations stay readable, and v1 locks replay under v1.
2. **A pure interpreter:**
   - it topologically orders components;
   - it evaluates bases and outcomes, rounds per component or per document as the rule
     says, and explains each step;
   - it applies a limit on depth and size, checked when a package is published.
3. **Publishing validation:**
   - no cycle, no unknown base, no overlapping rules of equal priority;
   - each rule's fixtures pass.
4. **Property tests:**
   - the same input and rules always give the same digest;
   - gross-up and reduction round-trip within one minor unit per component;
   - no path produces a floating-point number.

**Exit evidence**
- Phase 41's three rules, rewritten as expressions, reproduce the golden result.
- A package with a cycle, an unknown base or an oversized tree is refused when published.
- Explanations list every step with its value.

### 84 — IBS, CBS and the Imposto Seletivo through the transition, checked by the oracle

**Delivered on 2026-09-30 for IBS and CBS in 2026** ([plan](tax-phase84-implementation-plan.md),
[evidence](tax-phase84-evidence.md)). 56 tax classifications agree with the official
calculator on every seeded case. 2027 is proven with stated hypothetical rates and never
published; 2029 and 2033 and the Imposto Seletivo wait for published rates.

**Work**
1. **Packages for 2026 to 2033 from the source matrix:**
   - the rates and the schedule;
   - reduced-rate classes by `cClassTrib`;
   - destination for interstate operations;
   - the Imposto Seletivo for its declared products.
2. **The oracle:**
   - the official calculator runs from its pinned root filesystem in a container
     (`make tax-oracle`);
   - a corpus generator crosses dates, regimes, origin and destination, classification
     and amounts, including boundaries: 31 December, the last minor unit, returns;
   - every case runs through Horizon and the oracle, and any difference fails.
3. **CI:**
   - a `tax-oracle` workflow runs the corpus when a package changes, and weekly;
   - its report is stored under `docs/drills/`.
4. The corpus's agreed cases become the support matrix's IBS/CBS/IS rows.

**Exit evidence**
- Zero differences across the corpus: several thousand cases, with the exact count
  recorded.
- The same sale dated 2026, 2027, 2029 and 2033 calculates as the schedule says.
- An oracle version change is detected by its digest and holds the matrix until it is
  re-run.

### 85 — The legacy taxes, bounded by reviewed scenarios

**Delivered on 2026-09-30** ([plan](tax-phase85-implementation-plan.md),
[evidence](tax-phase85-evidence.md)). Seven scenarios were approved by the workspace owner:
ICMS for SP, RJ and BA; IPI; PIS/Cofins in both methods; DIFAL and FCP to an RJ
non-contributor; and São Paulo ISS. ICMS-ST and gross-up were left out, with their reasons.
`GET /fiscal/support` answers from a matrix generated from the oracle and the approvals.

**Work**
1. **Packages, each scenario with a fixture approved by the workspace owner:**
   - ICMS own: intrastate, and the 4%, 7% and 12% interstate rates;
   - ICMS gross-up;
   - DIFAL and FCP for a non-contributing final consumer;
   - ICMS-ST with adjusted MVA for a declared set of states and NCMs;
   - IPI from the TIPI;
   - PIS/Cofins, cumulative and non-cumulative;
   - ISS for the NFS-e service list, per municipality in the matrix.
2. **Tax on tax, as expressions:** IPI in the ICMS base where the law says so, ST over own
   ICMS, and FCP beside ICMS.
3. **The support matrix:**
   - generated per model, jurisdiction and scenario;
   - `GET /fiscal/support` answers from it;
   - an unsupported scenario says which dimension is missing.

**Exit evidence**
- Every legacy fixture passes, and each is reviewed and approved before activation.
- A scenario outside the matrix is `unsupported` with its missing dimension.
- An interstate sale to a non-contributor shows own ICMS, DIFAL and FCP, each explained.

### 86 — Regimes and the blend

**Delivered on 2026-10-01** ([plan](tax-phase86-implementation-plan.md),
[evidence](tax-phase86-evidence.md)). Eight scenarios were approved: the same resale for a
Simples, an MEI, a Presumido and a Real issuer; a Simples NFS-e; ICMS at 8/10 in 2030; and a
Simples exclusion on 1 July. The IBS side of the blend waits for the Senate's rates.

**Work**
1. **Taxpayer regimes as profile facts that rules read:**
   - Simples Nacional (CSOSN), including the option to collect IBS/CBS inside or outside
     it;
   - Lucro Presumido and Lucro Real (PIS/Cofins method);
   - MEI.
2. **The 2029–2032 blend:** ICMS and ISS reduction factors as dated rules, beside IBS's
   rise, so a single document carries both regimes in the proportions of its date.
3. **Regime changes during a year:** the fact's own window decides which regime a document
   sees; a later change never alters a locked calculation.

**Exit evidence**
- The same operation for a Simples, a Presumido and a Real issuer gives the expected
  components.
- A 2030 document shows ICMS at 80% of its rate beside IBS, and its explanation cites both.
- A regime change on 1 July applies from that day only.

### 87 — Taxes where money is decided

**Work**
1. **Sales:**
   - quotes and orders ask Fiscal for a preview when lines change;
   - they show the estimated taxes and the gross total, labeled as estimates;
   - the order keeps the preview's digests.

   The receivable is raised on the Fiscal lock when a document exists, and on the estimate
   otherwise, as today.
2. **Procurement:**
   - a purchase order's expected taxes come from a preview, replacing the typed amount;
   - the inbound XML reconciliation (Phase 44) compares the supplier's taxes with the
     expected ones, component by component, and names each difference.
3. **Financial and Ledger:**
   - a locked calculation's components travel on the fiscal document's event;
   - Ledger posts tax liabilities and recoverable credits by component. The accounts are
     declared in the chart, and the posting rule is decided in this phase's plan.
4. **Contracts** carry the preview and lock summaries (component, amount, digest), never
   the rules.

**Exit evidence**
- A quote shows its estimate, and the confirmed order keeps the digests.
- A supplier XML with a different ICMS shows the difference on the reconciliation.
- A locked document posts its tax components, and replaying the ledger produces the same
  balances.

### 88 — Governing the rules

**Work**
1. **Screens:**
   - the catalogue by package and version, with the diff between two versions;
   - the workspace's adoptions and its own rows;
   - the support matrix;
   - an explanation viewer on every fiscal document.
2. **Impact before adoption:** recalculate the workspace's documents of the last N months
   under the new version, without locking, and show what would change.
3. **Four eyes:**
   - adopting a version, or adding a workspace row, needs a request and another person's
     approval (ADR 0062's matrix gains `fiscal:rules:approve`);
   - every decision is audited.

**Exit evidence**
- An adoption requested by one person is refused to them and approved by another.
- The impact report lists every document whose amounts would change.
- The diff shows each rule added, ended or changed.

### 89 — Threat model, service levels, the golden path, and closing Phase O

**Work**
1. **The threat model:**
   - a tampered package (the digest is refused);
   - oracle drift (pinned digests, and the matrix held back);
   - a rounding exploit (per-component rounding, property tests);
   - a stale adoption (effective dates, the impact report);
   - an override without a reason (refused and audited).
2. **Service levels** in `infra/observability/rules/phase-o.rules.yml`:
   - preview latency;
   - the share of `unsupported` answers by missing dimension;
   - oracle disagreement, which must be zero;
   - a calculation lock that fails to replay, which must be zero.
3. **The Phase O golden path:**
   - adopt a package version;
   - quote, order, deliver and lock a document dated in 2027;
   - adopt the next version with an impact report;
   - replay the locked document unchanged;
   - check the ledger postings.
4. **Documents:** the roadmap entry moves out, `fiscal/README.md` and the support matrix
   are regenerated, and the phase is closed in `plan.md`.

**Exit evidence:** the four exit criteria above, each with its record under
`docs/drills/`.

## Order and dependencies

- **82 → 83 → 84:** the catalogue, then the language, then the reform's packages checked by
  the oracle.
- **85** needs 83's tax on tax.
- **86** needs 84 and 85, because the blend mixes both.
- **87** can start after 84 for IBS/CBS estimates; its legacy components wait for 85.
- **88** needs 82's adoptions and 83's diffable expressions.
- **89** closes.

## Risks

| Risk | Signal | Response |
|---|---|---|
| The domain outruns the reviewer | Fixtures waiting for approval pile up | The matrix grows only with approved fixtures; unsupported is an honest answer, not a failure |
| The oracle changes underneath | A new calculator version gives different results | Pinned by digest; a new version is a new source that re-runs the corpus before the matrix moves |
| The language grows into a programming language | Requests for conditionals inside formulas | Conditions belong in rule scope and precedence; the vocabulary grows only by ADR |
| Historical replay breaks | A locked document's digest changes | Explanation and schema versions are kept side by side; a failed replay is a zero-tolerance SLO |
| Estimates are mistaken for tax | A user treats a quote's tax as final | Labeled as estimates everywhere; only the lock reaches the books |
| The law changes during the phase | A rate or date moves in a new regulation | That is the point of data rules: a new package version, with its source |
