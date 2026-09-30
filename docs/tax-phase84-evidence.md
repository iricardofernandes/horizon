# Phase 84 evidence — IBS and CBS by tax classification, checked by the official calculator

[Plan](tax-phase84-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md)

## What was delivered

- **The tax classification on a line.**
  - `classifications.classTrib` (six digits) on the calculation input: contracts 0.54.0.
  - Rules scoped by `class_trib`: migration `0056_phase84_tax_classification.sql` widens the
    classification and reference checks.
  - A line that names a class needs the class's approved reference entry, as an NCM does.
- **Rounding as data of the formula.**
  - `rounding: "half-even"` rounds the base and the amount half to even
    (`roundHalfEven` in `exact-decimal.ts`), and the step text says so.
  - The component records the mode: contracts 0.55.0 widens `rounding.mode` to
    `half-away-from-zero | half-even`.
  - Without it, rounding stays half away from zero, so Phase 41's rules and every locked
    calculation are unchanged.
- **`fiscal/src/rtc-package.ts`, the package builder,** reads the calculator's database
  with `node:sqlite`:
  - each row as in force in the window, keyed by the class's row, since a code is reused
    with another meaning from 2027, and a later row of a code supersedes an earlier one;
  - the rate is `reference × (1 − reduction)`, exact;
  - exemption is `exempt`; immunity and non-incidence are `not-levied`; base exclusion is a
    `reduce` of the base; the rest are `levied`;
  - every class it leaves out is listed with its reason.
- **`fiscal/src/phase84-oracle-cli.ts` (`npm run phase84:oracle`)** builds, checks and
  publishes:
  - `build` writes a deterministic package, named by a manifest carrying the calculator's
    digest, the window, the rates and the digest of its own content;
  - `oracle` puts a seeded corpus to the engine and to the calculator, and fails on any
    difference, refusal or class without an agreeing case;
  - `publish` refuses a hypothetical package.
- **`make tax-oracle` (`scripts/tax-oracle.mjs`):**
  - takes the calculator pinned in the source manifest, downloading it with `DOWNLOAD=1`,
    and refuses any other digest;
  - imports its image as its own installer does, starts it on `127.0.0.1:18080` and waits
    for it;
  - builds the 2026 and hypothetical 2027 packages, and writes both reports under
    `docs/drills/`.
- **`.github/workflows/tax-oracle.yml`** runs it weekly, on demand, and when the package,
  its builder, the arithmetic, the script or the source manifest changes. The reports are
  kept as the job's artifact.

## The package

| | 2026 (published) | 2027 (hypothetical, never published) |
|---|---|---|
| Rates | CBS 0,9%, IBS UF 0,1%, IBS Mun 0% (the calculator's own) | CBS 8,8%, IBS UF 0,05%, IBS Mun 0,05%, stated |
| Classes | 56 | 45 |
| Rules | 285 | 234 |
| References | 10,576 (56 classes and the 8-digit NCMs) | 10,560 |
| Excluded | 105 | 131 |

The 2026 exclusions:
- **49** are not applicable to NF-e or NFC-e (NFS-e and other documents);
- **24** are suspensions (treatment 22), which the calculator refuses without the regular
  taxation they suspend;
- **32** have treatments the engine does not model: monophasic fuels, deferral, presumed
  credits, specific documents and others, one or a few classes each.

In 2027, the 29 classes of the Imposto Seletivo (treatments 1 and 2) are excluded too.

The package is rebuilt byte for byte from the pinned calculator (sha256 `aee8099a…` for
2026), so it is not committed.

## Proof

- **The oracle for 2026** ([report](drills/2026-09-30-phase84-oracle-2026.json), seed 84):
  - 3,000 documents and 6,104 lines, over 56 classes;
  - **6,104 agree, 0 differ, 0 refused**, every class supported.
  - A second run, seed 7: 5,000 documents and 9,996 lines, all agreeing.
- **The 2027 mechanics** ([report](drills/2026-09-30-phase84-oracle-hypothetical-2027.json)):
  - 3,000 documents and 6,104 lines over 45 classes, at the stated nominal rates;
  - **6,104 agree, 0 differ, 0 refused.**
- **What the oracle taught, each fixed before these runs:**
  - it rounds half to even: ours gave CBS 5 and IBS UF 1 at a tie where it gave 4 and 0;
  - a class's NCMs change over time and carry exceptions, spread across repeated rows of a
    prefix;
  - the 2026 and 2027 rows of one code are different classes.
- **A changed calculator is refused:** with a different file in place of the pinned zip,
  `tax-oracle` stopped with "The oracle changed: calculadora.zip is 46b2983b…, pinned
  13870dea…. Re-run and review", and deleted the file.
- **Unit tests (`rtc-package.spec.ts`, and additions to `exact-decimal`, `formula` and
  `rules`):** 203 in all, 12 new:
  - half to even at the calculator's own ties, negative values and near-ties;
  - a formula's rounding, and an unknown mode refused;
  - `class_trib` scope;
  - the effective rate;
  - why a class is left out;
  - rules per component and model;
  - outcomes and base exclusion;
  - determinism;
  - validity from the first to the last stored day.
- **e2e (`catalog.e2e-spec.ts`), 14 in all, 1 new:** a package from the builder published,
  adopted and previewed through the store:
  - 200032 over 1.000,00 gives CBS 3,60, IBS UF 0,40 and IBS Mun 0, half-even;
  - 000001 over 5,00 gives CBS 0,04 (0,045 to even);
  - 410001 is exempt;
  - a line without a classification is unsupported.
- **On the stack** ([record](drills/2026-09-30-phase84-catalog-rollout.json)):
  - migration 0056 applied;
  - the 2026 package published, and the hypothetical one refused;
  - the demo workspace adopted it, citing the oracle report.
  - Previews under a new operation gave:
    - 200032 over 1.000,00: **CBS 3,60**, IBS UF 0,40;
    - 000001: 0,90 and 0,10 over 100,00;
    - 200003: zero;
    - 410001: not levied;
    - no classification: `UNSUPPORTED_RULE`.
  - Phase 41's operation still gives its approved rules digest `25ade44c…`.

## Not done, stated

- **2029 and 2033 are not calculated.** The plan's exit evidence asked for the same sale
  dated 2026, 2027, 2029 and 2033. The CBS and IBS reference rates from 2027 depend on a
  Senate resolution not yet published. Only the 2027 mechanics are proven, with stated
  hypothetical rates.
- **The Imposto Seletivo** has no rates in any source, so it stays out. So do the Zona Franca
  adjustments, monophasic fuels, deferral, suspension and presumed credits (listed in each
  package's `excluded`).
- **The support matrix is not generated here.** The reports' per-class `matrix` is the
  evidence Phase 85 generates it from and serves at `GET /fiscal/support` (ADR 0072).
- **Interstate destination is not a dimension yet.** In 2026 the IBS rates are national, so
  the corpus's random municipalities do not change the answer.
- **A published package cannot be corrected in place.** The catalogue refuses a second
  package whose rules overlap the first's scopes, and its rows are immutable. Superseding a
  catalogue package is not built.
  - On the stack, the 2026 package was published before its manifest carried its content
    digest, so it is named by the calculator's digest (`d5791739…`).
  - Its rules and references are identical to the final build's; the record says so.
  - A fresh stack publishes the same rules under the manifest's name.

## Verification (2026-09-30)

- **`make tax-oracle`:** passed from a stopped oracle and a re-extracted database (identical
  to the first).
- **Fiscal unit tests (203) and the catalogue e2e (14):** passed.
- **`node scripts/ci-local.mjs --full`** passed in full: every module, clean installs, the
  contract gates and every image. Fiscal ran 203 unit tests and 71 e2e.
- **`make demo` twice, `make test-alerts` and `make test-phase10`:** passed.
- **`deck`:** not run, since `gateway/kong.yml` did not change.
- **The `tax-oracle` workflow** has not run on GitHub yet; it runs after the push.
