# Phase 85 evidence — The legacy taxes, bounded by reviewed scenarios

[Plan](tax-phase85-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md) ·
[Sources](tax-phase85-source-manifest.json)

## What was delivered

- **Fourteen legal sources pinned by digest** ([manifest](tax-phase85-source-manifest.json)).
  Each is stored under `.artifacts/fiscal/law/` and read for the provisions named:
  - LC 87/1996 (compiled with LC 190/2022) and Convênio ICMS 236/2021;
  - RICMS/SP art. 52;
  - RJ Lei 2.657/1996 art. 14 (20% since Lei 10.253/2023) and RJ LC 210/2023 (FECP,
    2 p.p.);
  - the TIPI spreadsheet (updated through ADE RFB 1/2026);
  - Leis 10.637, 10.833, 9.715 and 9.718, and DL 1.598 art. 12 §4º;
  - the PGFN opinion 7698/2021 on RE 574.706;
  - LC 116/2003 and SP Lei 13.701/2003 art. 16.

  The Senate resolutions are applied as RICMS/SP states them. IN RFB 2.121/2022 could not
  be retrieved as a document (the Receita's portal is a single-page application), so the
  PGFN opinion stands for it. Both are recorded in the manifest.
- **Scope dimensions** (migration `0057_phase85_scope_dimensions.sql`, in both the
  workspace and catalogue rules, and seen by the overlap guards):
  - `recipientTaxpayer`;
  - `issuerMunicipality`;
  - `fact`, one key and value of the line's `taxFacts`: `ipiTaxpayer`, `destinationUse`.
- **The formula language, additive to formula-v1:**
  - `difference` (`line.net − ICMS`);
  - `deduct`: the amount less other components, never below zero (LC 87 art. 8º §5º). Each
    deduction is its own explained step.
- **`fiscal/src/legacy-packages.ts`** builds two packages:
  - **goods** (ICMS for SP, RJ and BA; IPI from the TIPI; PIS/Cofins by regime), one
    package because its formulas read one another;
  - **São Paulo ISS.**
- **`fiscal/src/legacy-scenarios.ts`** declares the scenarios, and **`npm run
  phase85:scenarios`** builds, approves, publishes, adopts, verifies and generates the
  matrix.
- **The support matrix:**
  - `fiscal/support-matrix.json` is generated from the Phase 84 oracle report (56 IBS/CBS
    classifications, model 55) and the approved fixtures (7);
  - `GET /fiscal/support` answers the matrix, or a scenario as `supported` with its rows or
    `unsupported` with its missing dimension.

  Contracts 0.56.0 added `fiscalTaxSupport*`, 0.57.0 its `facts` query dimension, and
  0.58.0 registered the matrix, query and answer in the schema registry. All are additive,
  and every consumer is pinned with the tarball integrity verified.

## The approved scenarios

Approved by the workspace owner on 2026-09-30, each approval signing the fixture's exact
digest ([fixtures](../fiscal/fixtures/phase85/)). All are on a line of 2 × 189,90 =
379,80, NCM 8509.40.10, except F8.

| Fixture | Scenario | Result |
|---|---|---|
| F1 | SP → SP, contributor, resale; Lucro Real | ICMS 18% 68,36; PIS 1,65% 5,14 and Cofins 7,6% 23,67 over 311,44 |
| F2 | SP → RJ, contributor, resale | ICMS 12% 45,58 |
| F3 | SP → BA, contributor, resale | ICMS 7% 26,59 |
| F4 | SP → RJ, imported (origin 1), resale | ICMS 4% 15,19 |
| F5 | SP industrial → RJ non-contributor; Lucro Presumido | IPI 6,5% 24,69; ICMS 12% 48,54 over 404,49; DIFAL 8% 32,36; FCP 2% 8,09; PIS 0,65% 2,15 and Cofins 3% 9,94 over 331,26 |
| F6 | SP industrial → SP contributor, resale | IPI 24,69; ICMS 18% 68,36 over 379,80, without IPI |
| F8 | NFS-e, São Paulo, subitem 1.01 | ISS 2,9% 43,50 over 1.500,00 |

The approval also covers these readings:
- rounding half away from zero per line;
- only the own ICMS excluded from PIS/Cofins;
- the contributor covered only for resale;
- the 4% rate only for origin 1;
- DIFAL as the rate difference over base única;
- FECP on the declared NCM.

## Proof

- **Unit tests: 218.** New ones cover:
  - `difference` and `deduct`, including the floor at zero and the evaluation order;
  - the three scope dimensions;
  - the TIPI rate's normalization (`7.8000000000000007` → 39/500);
  - the packages' well-formedness;
  - F5's components, each explained;
  - a commerce seller's sale to a non-contributor, unsupported on `component:ICMS`;
  - the fixtures on disk equal to what the packages give, their approvals signing their
    digests;
  - the matrix's answers;
  - the committed matrix equal to what the evidence generates;
  - `GET /support`'s parsing.
- **e2e (`catalog.e2e-spec.ts`), 15 in all:** both packages published on a fresh database
  and adopted, and every fixture reproduced through the store byte for byte. A
  contributor's own-use purchase gets only its IPI.
- **On the stack** ([record](drills/2026-09-30-phase85-legacy-rollout.json)):
  - migration 0057 applied;
  - both packages published and adopted by the demo workspace, citing the approved
    fixtures;
  - **all 7 fixtures reproduced through the store**;
  - Phase 41 still gives rules `25ade44c…` and result `256201c9…`.
  - Through Kong, `GET /fiscal/support` gave:
    - the 63-row matrix;
    - F5's ICMS, DIFAL and FCP supported;
    - ICMS-ST `unsupported: tax`;
    - destination MG `unsupported: destinationState`;
    - own use `unsupported: facts`;
    - 200032 supported by the oracle.

## Not done, stated

- **ICMS-ST (F7).** No interstate agreement with its original MVA was pinned for a declared
  NCM. The `deduct` node it needs is built and tested.
- **Gross-up.** Importation and base dupla are outside the declared scenarios. Every
  declared sale's value already contains its ICMS.
- **Completeness at issuance.** A calculation applies the rules that exist. The matrix, not
  the calculation, says a scenario is incomplete, and refusing to issue on its answer is
  Phase 87's.
- **Every other state, municipality, NCM and service** stays unsupported until a fixture is
  approved for it. So do origins 2, 3 and 8, a contributor's own use, and Simples
  Nacional (Phase 86).
- **A published package still cannot be corrected in place** (Phase 84). The packages were
  published only after approval for that reason.

## Verification (2026-09-30)

- **`node scripts/ci-local.mjs --full`** passed in full: every module, clean installs, the
  contract gates and every image. Fiscal ran 218 unit tests and 72 e2e.
  - A first run failed on two gates. The generated matrix was not in the formatter's layout,
    so `matrix` now formats it. The new contract schemas were unregistered, so contracts
    0.58.0 registers them. Both were fixed and the whole run was repeated.
- **`make demo` twice, `make test-alerts` and `make test-phase10`:** passed.
- **`deck`:** not run, since `gateway/kong.yml` did not change (`/fiscal/support` is under
  the existing `/fiscal` route).
