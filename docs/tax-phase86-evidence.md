# Phase 86 evidence — Regimes and the blend

[Plan](tax-phase86-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md) ·
[Sources](tax-phase86-source-manifest.json)

## What was delivered

- **The issuer's regime, read at the issue date.**
  - `issuer.regime` keeps the NF-e's CRT meaning (`normal`, `simples-nacional`, `mei`), to
    which the approved rules of Phases 41 to 47 are scoped.
  - The new optional `issuer.incomeTaxRegime` (`lucro-real`, `lucro-presumido`) decides the
    PIS/Cofins method (contracts 0.59.0). Rules are scoped by it through
    `issuerIncomeTaxRegime` (migration `0058_phase86_income_tax_regime.sql`, seen by the
    overlap guards).
  - `issuer-regime.ts` maps the profile's `fiscalRegime` once, for NF-e and NFS-e alike.
  - The readiness services already read the issuer revision in force on the issue date, so
    a regime change applies from its own date. A Simples or MEI issuer's document can be
    previewed, but issuing it (CSOSN) is not built, so readiness still refuses it.
- **A package may name the components it reads from other packages** (`requires`). The
  publish check still refuses anything neither defined nor required. PIS/Cofins read the
  ICMS of Phase 85's package without republishing it.
- **Three packages** (`regime-packages.ts`), built from pinned sources:
  - **`phase86.pis-cofins.normal.2026`:** PIS/Cofins by income-tax regime for a normal
    issuer's resale, requiring ICMS.
  - **`phase86.simples-mei`:** for Simples and MEI issuers, at priority 200:
    - ICMS, PIS, Cofins, IPI (when the issuer is an IPI taxpayer) and ISS `not-levied`
      (LC 123 arts. 13 and 18-A);
    - CBS, IBS UF and IBS Mun `not-levied` in 2026 (LC 214 art. 348 III c). Phase 84's
      package would otherwise have charged them.
  - **`phase86.blend.2029-2032`:** every Phase 85 ICMS and ISS rule, once a year, at 9/10,
    8/10, 7/10 and 6/10 of its rate (EC 132 ADCT art. 128). FCP is left out.
- **`npm run tax:scenarios -- <action> --phase 85|86`** replaces the Phase 85 command,
  which stays as an alias. The matrix reads every phase's approved fixtures.
- **The support matrix:**
  - rows now say the issuer regime they were proven for, taken from the fixture's input.
    Before this, a normal issuer's Phase 85 row also answered for a Simples issuer;
  - the Phase 84 oracle rows say `normal`;
  - `incomeTaxRegime` is a query dimension.

## The approved scenarios

Approved by the workspace owner on 2026-10-01, each approval signing the fixture's exact
digest ([fixtures](../fiscal/fixtures/phase86/)). All are SP → SP resales to a contributor
of 2 × 189,90 = 379,80, NCM 8509.40.10, unless stated.

| Fixture | Scenario | Result |
|---|---|---|
| G1 | Simples, 2026, cClassTrib 000001 | ICMS, PIS, Cofins, CBS, IBS UF, IBS Mun: not levied |
| G2 | MEI, 2026, cClassTrib 000001 | the same, citing LC 123 art. 18-A |
| G3 | Lucro Presumido | ICMS 68,36; PIS 2,02 and Cofins 9,34 over 311,44 |
| G4 | Lucro Real | ICMS 68,36; PIS 5,14 and Cofins 23,67 over 311,44 |
| G5 | NFS-e, Simples provider, São Paulo, 1.01 | ISS not levied |
| G6 | Lucro Real, 15 March 2030 | ICMS 14,4% (8/10 of 18%) = 54,69 |
| G7A | Simples, 30 June 2026 (excluded from 1 July) | not levied, as G1 |
| G7B | Lucro Presumido, 1 July 2026 | as G3 |

## Proof

- **Unit tests: 228.** New ones cover:
  - the regime mapping;
  - `requires` in the package check;
  - the income-tax regime scope;
  - the packages' well-formedness;
  - Simples and MEI answers, each explained;
  - Presumido against Real;
  - the blend's fractions (81/500, 18/125, 63/500, 27/250 of the 18% rate; ISS 29/1250 in
    2030; no FCP);
  - the fixtures on disk.
- **A 2030 document beside a hypothetical IBS:** ICMS 54,69 citing ADCT art. 128 (8/10), and
  IBS UF 37,98 at a stated hypothetical 10%. The source says so, and it is never published.
- **e2e (`catalog.e2e-spec.ts`), 16 in all:**
  - on a fresh database, all 8 fixtures reproduce through the store;
  - a sale locked on 30 June as Simples replays unchanged.
- **On the stack** ([record](drills/2026-10-01-phase86-regimes-rollout.json)):
  - migration 0058 applied;
  - the three packages published and adopted;
  - all 8 Phase 86 fixtures and all 7 Phase 85 ones reproduce through the store;
  - Phase 41 still gives `25ade44c…` and `256201c9…`.
  - `GET /fiscal/support` gave:
    - Simples ICMS SP → SP supported;
    - Simples SP → RJ `unsupported: issuerRegime`;
    - PIS without `incomeTaxRegime` `unsupported: incomeTaxRegime`;
    - 2030 ICMS supported;
    - 2030 IBS `unsupported: tax`.

## Not done, stated

- **The IBS side of the blend.** The Senate has not published the 2029–2032 reference rates.
  It is shown only with a hypothetical rate in a test. The blend's ICMS assumes today's
  state rates still stand then, as every dated rule does.
- **The Simples ICMS credit (CSOSN 101)** needs the issuer's last 12 months of revenue.
- **IBS/CBS outside the Simples** is an option from 2027, whose rates are unpublished.
- **ST and DIFAL for Simples issuers,** and FCP in the blend: not settled by the sources
  pinned.
- **Issuing a Simples or MEI issuer's NF-e** (the CSOSN document mapping) is not built.
  Readiness refuses it; the calculation is previewable.
- **The matrix classifies a row once.** The Simples rows are by NCM, so asking for a Simples
  line by `cClassTrib` answers `unsupported`, conservatively.

## Verification (2026-10-01)

- **`node scripts/ci-local.mjs --full`** passed in full: every module, clean installs, the
  contract gates and every image. Fiscal ran 228 unit tests and 73 e2e.
- **`make demo` twice, `make test-alerts` and `make test-phase10`:** passed.
- **`deck`:** not run, since `gateway/kong.yml` did not change.
