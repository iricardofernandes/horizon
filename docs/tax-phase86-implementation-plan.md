# Phase 86 — Regimes and the blend

Status: **delivered on 2026-10-01** ([evidence](tax-phase86-evidence.md)). The fifth phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O), under [ADR 0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md): each
scenario is supported only once its fixture is approved by the workspace owner.

## What the code and the law already decide

- **The issuer's regime is a profile fact with a window.** Identity keeps the company's
  `fiscalRegime` (`simples-nacional`, `lucro-presumido`, `lucro-real`, `mei`, `not-declared`)
  in profile revisions with `effectiveFrom`, and Fiscal projects them. The calculation
  input still says `issuer.regime: 'normal'` for every document.
- **`normal` is the NF-e's own word** (CRT 3, regime normal: Lucro Real or Presumido). The
  approved rules of Phases 41, 45, 46 and 47 are scoped to it, and the catalogue cannot
  change a published rule. So `issuer.regime` keeps the CRT meaning (`normal`,
  `simples-nacional`, `mei`). The income-tax regime, which decides the PIS/Cofins method,
  becomes its own optional field, `issuer.incomeTaxRegime` (`lucro-real`,
  `lucro-presumido`), with its own scope dimension.
  - Phase 85's F1 and F5 used `lucro-real` and `lucro-presumido` as `issuer.regime`. They
    stay valid as written. Real documents reach PIS/Cofins through the new dimension.
- **Simples Nacional and MEI collect ICMS, IPI, PIS/Cofins and ISS in the DAS**
  (LC 123/2006 arts. 13 and 18-A). A document of a Simples or MEI issuer carries none of
  them. The engine says so explicitly, as `not-levied` with the source, rather than by
  leaving the components out.
- **The 2026 IBS/CBS test rates do not apply to Simples optants** (LC 214 art. 348 III c).
  Today Phase 84's package would calculate CBS for a Simples issuer's classified line. An
  override fixes that.
- **The regime cannot change mid-year by choice.** The Lucro Presumido option is
  irrevocable for the calendar year (Lei 9.718 art. 13 §1º). A mid-year change is an
  exclusion from the Simples (LC 123 arts. 30 and 31), so that is the scenario on 1 July.
- **The blend:** from 2029 to 2032, ICMS and ISS rates are 9/10, 8/10, 7/10 and 6/10 of the
  rates the state and municipal laws fix (EC 132 ADCT art. 128), and their benefits shrink
  in the same proportion (§1º).
  - The IBS reference rates of those years are set by a Senate resolution not yet
    published. So the IBS side of a blended document is proven with stated hypothetical
    rates in a test, never published, as Phase 84 did for 2027.

## Work

1. **Contracts:** optional `issuer.incomeTaxRegime` on the calculation input, an additive
   minor release.
2. **Scope:** `issuerIncomeTaxRegime` in workspace and catalogue rules (migration 0058),
   seen by the overlap guards.
3. **A package may name the components it reads from other packages** (`requires`). The
   publish check still refuses a component that is neither defined nor required. At
   calculation, a required component the line does not select answers `UNSUPPORTED_RULE`
   (`component:<CODE>`), as it already does. This lets PIS/Cofins, which read ICMS, be
   published beside Phase 85's ICMS without republishing it. The catalogue refuses an
   overlapping rule, and a package cannot be superseded.
4. **The regime at the issue date:** the input builders set `issuer.regime` and
   `issuer.incomeTaxRegime` from the issuer revision given. The revision must be the one
   in force on the issue date, or the document is refused as stale. A later revision never
   changes a locked calculation, which keeps its input.
5. **Packages:**
   - `phase86.pis-cofins.normal.2026` — PIS/Cofins by `issuerIncomeTaxRegime` for
     `issuer.regime = normal`, requiring ICMS;
   - `phase86.simples-mei` — for `simples-nacional` and `mei`, at a priority above every
     tax rule:
     - ICMS, IPI, PIS, Cofins and ISS `not-levied`;
     - CBS, IBS UF and IBS Mun `not-levied` in 2026;
   - `phase86.blend.2029-2032` — the Phase 85 ICMS and ISS rules again, one per year, at
     their rate times the year's fraction.
6. **Fixtures, for the owner's review:**
   - G1 to G4: the same SP → SP resale as a Simples, an MEI, a Lucro Presumido and a Lucro
     Real issuer;
   - G5: a Simples provider's NFS-e in São Paulo;
   - G6: a 2030 SP → SP resale by a normal issuer, with ICMS at 8/10 of 18%;
   - G7: a Simples issuer excluded on 1 July, one document dated 30 June and one dated
     1 July.
7. **The support matrix** gains the approved rows. The Phase 85 matrix query already
   carries `issuerRegime`; `incomeTaxRegime` joins it as a dimension.

## Left out, stated

- **The Simples ICMS credit (CSOSN 101, pCredSN).** It depends on the issuer's revenue over
  the last 12 months and its annex bracket, a fact Fiscal does not hold. CSOSN 102 (no
  credit) is modelled.
- **Collecting IBS/CBS outside the Simples**, an option from 2027. The 2027 rates are
  unpublished, so it waits with them.
- **ST and DIFAL for Simples issuers.** ICMS under substitution falls outside the DAS
  (LC 123 art. 13 §1º XIII a). The DIFAL on a Simples issuer's sale to a non-contributor in
  another state is not settled by the sources pinned. Both are unsupported.
- **FCP in the blend,** where whether the fund's additional shrinks with the rate is not
  settled by the sources pinned.

## Exit evidence

- The same operation for a Simples, an MEI, a Presumido and a Real issuer gives the
  expected components, each explained.
- A 2030 document shows ICMS at 80% of its rate. Beside a hypothetical IBS, it cites both.
- A Simples exclusion on 1 July applies from that day only, and a June calculation locked
  before it replays unchanged.
- The Phase 41, 84 and 85 results are unchanged.
