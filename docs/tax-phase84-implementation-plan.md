# Phase 84 — IBS, CBS and the Imposto Seletivo through the transition, checked by the oracle

Status: **delivered on 2026-09-30 for IBS and CBS in 2026** ([evidence](tax-phase84-evidence.md)).
The third phase of the [tax rules engine plan](tax-engine-plan.md) (Phase O), implementing
[ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md) for IBS and CBS.

## What the oracle can and cannot prove (found on 2026-09-30)

The official calculator (V0059, pinned in Phase 82's
[source manifest](tax-phase82-source-manifest.json)) was imported as an image and queried
on `POST /api/calculadora/regime-geral`:
- **2026:**
  - it calculates on its own. CBS 0,9% and IBS UF 0,1% over 100,00 give 0,90 and 0,10;
  - it applies each tax classification (`cClassTrib`): 200032, reduced by 60%, gives CBS
    3,60 over 1.000,00; 200003, zero-rated, gives 0.
- **From 2027:** it refuses to calculate (`aliquotas-nominais-nao-informadas`) unless the
  caller supplies the nominal rates (`cbs`, `ibsEstadual`, `ibsMunicipal`). Those are the
  Senate's reference rates, which do not exist yet. Given rates, it applies the same
  mechanics: nominal rate × (1 − reduction), then the base times the effective rate,
  rounded.
- **It rounds half to even.** At exact ties it gives 0,045 → 0,04, 0,135 → 0,14,
  0,225 → 0,22, 0,495 → 0,50 and 0,015 → 0,02.
- **Its own formulas are data** (`TRATAMENTO_TRIBUTARIO`):
  - the effective rate is `aliquota*(1-percentualReducao)*(1-pRedutorCompraGov/100)`;
  - the tax is `baseCalculo*aliquotaEfetiva`;
  - special treatments (monophasic fuels, deferral, credit transfers, Zona Franca
    adjustments, fixed rates, the Imposto Seletivo) have formulas of their own.
- **Its database is versioned by date,** and a class code is reused: 000001 is full taxation
  in 2026 and "first supply of goods" from 2027. Each class's NCMs have exceptions
  (`EXCECAO_NCM_APLICAVEL`, the annexes' "exceto …"), spread across repeated rows of one
  prefix.

So:
- **2026 can be supported,** class by class, where the oracle agrees.
- **2027 onward can have its mechanics proven now,** with stated hypothetical nominal
  rates, but it cannot be law until the Senate publishes the rates. No 2027-onward rule is
  published to the catalogue in this phase.
- **The Imposto Seletivo has no rates in any source.** It stays out.

## Result

- **A calculation line can name its tax classification** (`classifications.classTrib`,
  six digits; contracts 0.54.0), and rules can be scoped by it (`class_trib`, migration
  0056).
- **A formula can name its rounding** (`rounding: "half-even"`), applied to the base and the
  amount; the component records the mode (contracts 0.55.0). Phase 41's rules keep half
  away from zero.
- **The 2026 package is built from the calculator's own database,** never typed by hand:
  - 56 tax classifications applicable to NF-e and NFC-e, whose treatment the engine models:
    full taxation, reductions, zero rate, exemption, immunity and non-incidence, and base
    exclusion. The other 105 rows of 2026 are listed in the package as excluded, each with
    its reason;
  - each class gives CBS, IBS UF and IBS Mun rules per model at the effective rate, with
    the classification's reference entry and the 8-digit NCMs;
  - it is published, and the demo workspace adopts it.
- **The oracle runs as `make tax-oracle`:**
  - a seeded corpus of documents of one to three items, all of one class, over NCMs the
    class applies to on the day (exceptions included, the Imposto Seletivo's NCMs excluded),
    municipalities, amounts (including half-cent ties) and dates (1 January, 31 December and
    between) goes through the engine and through the oracle;
  - any difference, any refusal and any class without an agreeing case fails;
  - the reports are stored under `docs/drills/`; their `matrix` is the per-class evidence
    the support matrix is generated from in Phase 85.
- **The 2027 mechanics are proven too,** with hypothetical nominal rates stated in the
  report and never published: 45 classes, the 2027 versions of each code.
- **A `tax-oracle` workflow** downloads the calculator, refuses a digest other than the
  pinned one ("the oracle changed: re-run and review"), and runs the corpus weekly and when
  the package, its builder or the arithmetic changes.

## Decisions

1. **The reduction lives in the rate, not the base.** The oracle computes an effective rate
   and multiplies the base by it, so the package's rate is `reference × (1 − reduction)`.
   The rule's `sourceLocator` names the class, its treatment and its reduction.
   - Base exclusion (treatment 17, ×0.5; treatment 40, ×0) is a `reduce` expression on the
     base, as the oracle writes it.
2. **Outcomes follow the treatment:**
   - exemption (`Isenção`) is `exempt`;
   - immunity and non-incidence are `not-levied`;
   - the rest are `levied`.
   - **Suspension is not modelled:** the calculator refuses it without the regular
     taxation it suspends (`gTribRegular`), which the calculation input does not carry.
3. **Scope:**
   - model 55 and 65, the simulation environment (Phase J enables no other), `default`
     precedence, classification `class_trib:<code>`;
   - lines without a classification are not matched, and Phase 41's operation rules
     outrank `default`, so its approved scenario keeps its result.
4. **A class's applicability to an NCM is the caller's responsibility** (Catalog and Fiscal
   profiles; Phase 87). The corpus asks only what applies.
5. **The rounding is data of the formula,** not of the engine: half to even is proven by the
   oracle's own answers, and nothing already approved changes.
6. **The builder is `phase84:oracle build`.** It reads the calculator's SQLite database with
   Node's built-in `node:sqlite`, keyed by the class row and only the rows in force in the
   window, and a later row of a code supersedes an earlier one. The package JSON is
   deterministic and is written under `.artifacts/fiscal/packages/`, not committed: it is
   rebuilt byte for byte from the pinned calculator.
7. **A built package is named by its manifest:** the calculator's digest, the window, the
   rates and the digest of its own rules and references. One calculator yields several
   packages.
8. **No partial year is published.** A 2027 package with IBS and no CBS would silently
   under-tax, so nothing is published until every component of a year has a source.

## Proof

- **Unit tests:** half-to-even rounding; the formula's rounding; `class_trib` scope in
  resolution; the builder's mapping (rate arithmetic, outcomes, base exclusion, exclusions,
  determinism, validity).
- **The oracle reports:** the number of cases, 0 differences, 0 refusals and each class
  supported; the hypothetical 2027 run, likewise.
- **e2e:** a package from the builder published, adopted and previewed for a reduced-rate
  line, a half-cent tie and an exempt line.
- **On the stack:** publish and adopt. A preview of a 60%-reduced line gives CBS 3,60 over
  1.000,00, as the oracle does.
