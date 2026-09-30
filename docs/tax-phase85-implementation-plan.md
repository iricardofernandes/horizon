# Phase 85 — The legacy taxes, bounded by reviewed scenarios

Status: **delivered on 2026-09-30** ([evidence](tax-phase85-evidence.md)). The fourth phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O), implementing [ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md)
for ICMS, IPI, PIS/Cofins and ISS, and the support matrix.

## The rule this phase lives by

No official calculator exists for the legacy taxes. A scenario is supported only when the
workspace owner has reviewed and approved its fixture, as in Phase 41. Each fixture carries:
- the input;
- the expected result, calculated by the engine from the package;
- every step explained;
- the legal sources, pinned by digest, and the provision behind each number.

A fixture waiting for review supports nothing. The support matrix is generated from
approved fixtures and the Phase 84 oracle reports, never written by hand.

## Scope: the declared scenarios

The jurisdictions are São Paulo as the issuer, and Rio de Janeiro and Bahia as
destinations. Every scenario is NF-e model 55 in simulation, issued on a 2026 date, with a
declared NCM or service. Anything else stays `unsupported`, naming the missing dimension.

| Fixture | Operation | Components | Sources |
|---|---|---|---|
| F1 | SP → SP, contributor, resale; Lucro Real seller | ICMS 18%; PIS 1,65% and Cofins 7,6% non-cumulative | RICMS/SP art. 52 I; Leis 10.637 and 10.833 art. 2 |
| F2 | SP → RJ, contributor | ICMS 12% | RICMS/SP art. 52 III; Res. SF 22/1989 |
| F3 | SP → BA, contributor | ICMS 7% | RICMS/SP art. 52 II; Res. SF 22/1989 |
| F4 | SP → RJ, contributor, imported goods (origin 1, 2, 3 or 8) | ICMS 4% | RICMS/SP art. 52 §2º; Res. SF 13/2012 |
| F5 | SP industrial → RJ, non-contributor final consumer; Lucro Presumido seller | IPI (TIPI); ICMS 12% over net + IPI; DIFAL 8% and FCP 2% over the same base; PIS 0,65% and Cofins 3% cumulative | TIPI; LC 87 art. 13 X, §1º I, §2º, §3º; Conv. ICMS 236/2021; RJ Lei 2.657 art. 14 I; RJ LC 210/2023 art. 2º I; Leis 9.715 and 9.718 |
| F6 | SP industrial → SP, contributor, resale | IPI (TIPI); ICMS 18% over net, without IPI | LC 87 art. 13 §2º; TIPI |
| F7 | SP → another state with ICMS-ST by agreement | ICMS own; ICMS-ST over the adjusted MVA, less own ICMS | LC 87 art. 8º; Conv. ICMS 142/2018; the agreement and its MVA |
| F8 | NFS-e, provider in São Paulo, subitem 1.01 | ISS 2,9% | LC 116 art. 3º; SP Lei 13.701 art. 16 III |

- **F7 was left out:** no interstate ST agreement with its original MVA was pinned for a
  declared NCM. The `deduct` node it needs is built and unit-tested.
- **Gross-up is not a scenario here.** Every declared sale's value already contains its ICMS
  (LC 87 art. 13 §1º I, and base única for the non-contributor). A gross-up is needed where
  the value excludes ICMS: importation (art. 13 V) and base dupla for a contributor's own
  use. Both are outside the declared set. The Phase 83 node stays as it is.
- **PIS/Cofins base** is the revenue without the IPI charged separately (DL 1.598 art. 12
  §4º) and without the ICMS charged on the document (STF Tema 69; IN RFB 2.121/2022). The
  fixture shows it as `line.net − ICMS`.
- **The seller's regime is a scope dimension** for PIS/Cofins (`issuerRegime`:
  `lucro-real`, `lucro-presumido`). Phase 86 turns regimes into profile facts.

## Engine and contract changes

1. **Scope dimensions:**
   - `recipientTaxpayer`: whether the recipient is an ICMS contributor. It decides the
     interstate rate versus DIFAL, and whether IPI enters the ICMS base;
   - `issuerMunicipality`, for ISS, due where the provider is established (LC 116 art. 3º);
   - `fact`, one key and value of the line's `taxFacts`. It carries what no other
     dimension can: whether the issuer is an IPI taxpayer for the item (`ipiTaxpayer`), and
     what a contributor does with the goods (`destinationUse`, only `resale` declared).

   They are stored in the workspace and catalogue rule tables (migration 0057), and the
   overlap guards see them. The contracts do not expose rule scopes, so they do not change
   for this.
2. **The formula language (formula-v1, additive):**
   - `{ "difference": [a, b] }`, for `net − ICMS`;
   - `deduct: ["ICMS"]` on the expression: the amount is `max(0, round(base × rate) −
     Σ deducted)`, as ST is "the difference between the tax at the destination's rate and
     the own-operation tax" (LC 87 art. 8º §5º). Each deduction is its own step.

   A package using them is refused by an engine that does not know them. Old packages are
   unchanged.
3. **Component codes** (group `legacy`): `ICMS`, `ICMS_ST`, `ICMS_UF_DEST` (DIFAL),
   `FCP_UF_DEST`, `IPI`, `PIS`, `COFINS`, `ISS`.
4. **Rounding:** the legacy packages round half away from zero, per line, to the cent. No
   legal rule fixes it, and the NF-e validation tolerates a cent. The reviewer approves it
   with each fixture.

## The packages

A package is checked on its own when published (Phase 83), and ICMS reads IPI while
PIS/Cofins read ICMS, so the goods taxes are one package:
- **`phase85.goods.sp-rj-ba.2026`:**
  - the SP internal rate and the interstate rates;
  - the imported-goods rate by `origin` classification;
  - RJ's internal rate and FECP for the non-contributor, by destination;
  - the IPI-in-base expressions by `recipientTaxpayer`;
  - IPI for the declared NCM, read from the pinned TIPI spreadsheet (float noise
    normalized; an `NT` row refused);
  - PIS/Cofins by issuer regime.
- **`phase85.iss.sao-paulo.2026`:** the declared service subitem at its article 16 rate.

Each package is published to the catalogue with its sources in the source manifest
(`docs/tax-phase85-source-manifest.json`). The documents are stored content-addressed
under `.artifacts/fiscal/law/`.

## The support matrix

- **Completeness is the matrix's answer.** A calculation applies the rules that exist, so a
  contributor buying for its own use still gets its IPI, with no ICMS rule. The matrix
  answers that scenario `unsupported` on `facts`. Refusing it at issuance belongs where
  documents are issued from estimates (Phase 87).
- **`fiscal/support-matrix.json`** is generated by `npm run phase85:matrix` from:
  - the Phase 84 oracle reports, one row per supported IBS/CBS classification;
  - the approved fixtures, one row per scenario.

  Each row has the model, environment, taxes, dimensions (origin and destination states,
  recipient taxpayer, NCM or service, issuer regime, municipality), the window, and its
  evidence (report or fixture, with digest). A unit test regenerates it and fails when the
  committed file differs.
- **`GET /fiscal/support`** answers from it:
  - with no query, the matrix itself;
  - with a scenario query, `supported` with the matching rows, or `unsupported` with the
    first dimension no row covers (`missingDimension`).

  It uses contracts' `fiscalTaxSupport*` schemas (0.56.0; 0.57.0 for the `facts`
  dimension of a query, `fact.<key>=<value>`; 0.58.0 registers them).

## Approval

The fixtures are generated by `npm run phase85:fixtures -- build` and written with
`approval: null`. I present each one to the workspace owner, with its computation and
sources. An approval is recorded only on the owner's word: `approvedBy`, `approvedAt`, the
approved scope and the fixture's digest. Adoption in the demo workspace cites the approved
fixtures. The matrix lists a scenario only after its approval.

## Exit evidence

- Every legacy fixture passes, and each is approved before activation.
- A scenario outside the matrix is `unsupported` with its missing dimension.
- An interstate sale to a non-contributor (F5) shows own ICMS, DIFAL and FCP, each
  explained with its base, rate and source.
- The Phase 41 and Phase 84 results are unchanged.
