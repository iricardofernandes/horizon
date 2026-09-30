# Phase 82 source matrix — the tax reform

[Plan](tax-phase82-implementation-plan.md) · [manifest](tax-phase82-source-manifest.json) ·
[Phase O plan](tax-engine-plan.md)

Every rate, date and proportion that Phase O turns into a rule comes from a source listed
here. Each file was retrieved on 2026-09-30 and kept under `.artifacts/fiscal/` by its
SHA-256. The manifest holds the digests.

## Sources

| Source | What Phase O takes from it | SHA-256 |
|---|---|---|
| **EC 132/2023** (Planalto) | The transition, ADCT arts. 125–130 | `1c2213f8…389a` |
| **LC 214/2025** (Planalto) | The IBS and CBS transition rates, arts. 14, 343, 344, 346, 347 | `11ff1e2b…8d9f` |
| **Official calculator, V0057** | Catalogue version 1 (Phase 41's scenario) | `f451c390…b68e` |
| **Official calculator, V0059** (published 2026-09-30) | Retained as Phase 84's oracle candidate, not yet adopted | `13870dea…2fa` |

## The transition, as the sources state it

| Period | What the sources say | Where |
|---|---|---|
| 2026 | IBS at a 0,1% state rate; CBS at 0,9%, compensated against PIS/Cofins | EC 132 ADCT art. 125; LC 214 arts. 343, 346 |
| From 2027 | CBS and the Imposto Seletivo are charged. PIS/Cofins end. IPI goes to zero, except for products with incentivized industrialization in the Zona Franca de Manaus, and is not cumulative with the IS | EC 132 ADCT art. 126 |
| 2027–2028 | IBS at 0,05% state and 0,05% municipal, with reduced-rate regimes applied. CBS at its art. 14 rate minus 0,1 percentage point, except for fuels | EC 132 ADCT art. 127; LC 214 arts. 344, 347 |
| 2029–2032 | ICMS and ISS at 9/10, 8/10, 7/10 and 6/10 of their rates. Their benefits are reduced in the same proportion | EC 132 ADCT art. 128 |
| From 2033 | ICMS and ISS end | EC 132 ADCT art. 129 |
| Throughout | The reference rates of IBS and CBS are set by Senate resolution | EC 132 ADCT art. 130; LC 214 art. 14 |

These confirm the shape in the [Phase O plan](tax-engine-plan.md#the-reform-as-the-engine-must-represent-it).

## What the sources do not give yet

- **The full CBS and IBS rates from 2027** depend on the Senate's reference rates. The
  current calculator (V0059) holds reference rates for 2026 only. Until the rates are
  published:
  - a 2027-onward package can carry only the deltas the law fixes (the 0,05% IBS rates,
    the 0,1 point CBS reduction);
  - a scenario that needs the full rate stays `unsupported`, naming that dimension.
- **The calculator changed on the day this matrix was made.** V0057, which Phase 41
  approved, became V0059, with a new digest and size. Catalogue version 1 stays on V0057.
  Adopting V0059 is Phase 84's work: re-run the corpus, then move.
- **The NF-e technical notes** for the IBS/CBS/IS fields are left to Phase 84's document
  mapping.
