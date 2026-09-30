# Phase 82 evidence — Decisions, the reform's source matrix, and a shared catalogue

[Plan](tax-phase82-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[source matrix](tax-phase82-source-matrix.md) · [rollout record](drills/2026-09-30-phase82-catalog-rollout.json)

## Decisions

The four ADRs of Phase O are recorded and indexed under *The tax rules engine*:
- [0070](adr/0070-tax-law-is-a-shared-catalogue-that-workspaces-adopt.md): tax law is a
  shared catalogue that workspaces adopt. Implemented here.
- [0071](adr/0071-tax-formulas-are-data-over-a-closed-vocabulary.md): formulas are data
  over a closed vocabulary. Phase 83.
- [0072](adr/0072-a-tax-scenario-is-supported-only-with-evidence.md): a scenario is
  supported only with evidence. Phases 84–85.
- [0073](adr/0073-tax-estimates-outside-fiscal-amounts-inside-it.md): estimates outside
  Fiscal, amounts inside it. Phase 87.

## The source matrix

- **The texts:** EC 132/2023 and LC 214/2025 were retrieved from Planalto and kept under
  `.artifacts/fiscal/law/` by digest.
- **The transition in them matches the Phase O plan:**
  - 2026: CBS 0,9%, IBS 0,1%;
  - 2027: CBS and IS begin, PIS/Cofins end, IPI goes to zero outside the Zona Franca;
  - 2027–2028: IBS 0,05% state and 0,05% municipal, CBS minus 0,1 point;
  - 2029–2032: ICMS and ISS at 9/10, 8/10, 7/10 and 6/10 of their rates;
  - 2033: ICMS and ISS end.

  Each is cited by article.
- **Two findings shape the next phases:**
  - **The full CBS and IBS rates from 2027 are not in any source yet.** They come from
    Senate resolution (LC 214 art. 14), and the official calculator's reference-rate table
    holds 2026 only. Scenarios that need them will stay `unsupported` until published.
  - **The official calculator changed while this phase ran.** V0057 (Phase 41) became
    V0059, published 2026-09-30, with a new digest (`13870dea…`) and size. V0059 is kept
    as Phase 84's oracle candidate. Catalogue version 1 stays on V0057, which is what was
    approved.

## The catalogue

- **Migration `0054_phase82_catalog.sql`:**
  - `fiscal_catalog_packages`, `fiscal_catalog_references` and `fiscal_catalog_rules`,
    with no tenant;
  - `fiscal_package_adoptions` per workspace, under RLS.
  - Catalogue tables force row security like every Fiscal table. Their only policies are a
    read for the application and a publish for the migration role, and the application has
    no write grant.
  - Every row is immutable.
  - Catalogue rules may only be `operation` or `default`, and never scoped to an
    establishment, a party or an item.
  - Adoption events are validated: no double adoption, no withdrawal of what was not
    adopted.
- **`src/catalog.ts`:**
  - `FiscalCatalog.publish`, with preserved identity for Phase 41's package;
  - `adopt` and `withdraw`, each audited in the workspace's chain;
  - an adoption that would tie with an active workspace rule is refused
    (`CatalogAdoptionClash`).
- **`FiscalRuleStore.resolve`** now reads the workspace's own rows and the rules of the
  packages it adopted, with Phase 41's precedence:
  - an adopted rule applies from the later of its own start and the adoption's;
  - adopted reference entries count as approved.
- **Shared rule shapes** moved to `src/rule-rows.ts`, so the store and the catalogue share
  them without an import cycle.
- **`phase82:catalog`** (`src/phase82-catalog-cli.ts`) has five actions: `publish-phase41`,
  `retire-copy`, `adopt`, `verify` and `verify-lock`.

## Proof

- **e2e `test/catalog.e2e-spec.ts`,** 10 of 10:
  - Phase 41's package and rule ids are kept;
  - the application reads the catalogue and cannot insert or delete (`permission denied`);
  - a rule scoped to an establishment is refused;
  - **the fixture's own input reproduces the approved result byte for byte from the
    catalogue;**
  - two workspaces on the same version get the same rules digest and lines;
  - unsupported before adopting and after withdrawing;
  - an adoption from 1 October does not apply on 30 September, and does on 1 October;
  - a locked calculation replays unchanged after the adoption is withdrawn;
  - an adoption that ties with the workspace's own active copy is refused, and allowed once
    the copy is retired;
  - adoption and withdrawal are in the workspace's audit chain.
- **The existing guard** that every Fiscal table forces RLS holds for the new tables. It
  failed on the first draft, which had left the catalogue without row security.
- **The rollout on the stack** ([record](drills/2026-09-30-phase82-catalog-rollout.json)).
  In the demo workspace:
  - verify with its own copy;
  - publish Phase 41's package as the migration role;
  - retire the copy (3 rules), after which the scenario is unsupported;
  - adopt from 2026-01-01;
  - verify from the catalogue.

  The result matches the approved fixture, and the Phase 41 document's lock replays.
  Every digest is Phase 41's:
  - input `c68492b3…`;
  - rules `25ade44c…`;
  - result `256201c9…`.

## Not done, stated

- **The five packages of the Phase 42–47 drill workspace stay workspace rows,** as the plan
  decided. Phases 84–86 publish the law they stand for.
- **`make smoke-phase41` fails,** but not because of this phase. Its last assertion expects
  the Phase 41 wording of the "no capability" refusal, which Phase 42 changed
  (`ddadc1a`). Its preview and explanation checks pass before that assertion. The lock was
  verified directly with `verify-lock` instead of editing another phase's smoke.
- **There are no screens or HTTP endpoints for the catalogue.** Adoption is a CLI until
  Phase 88's governance screens.

## Verification (2026-09-30)

- **`node scripts/ci-local.mjs --full`:** every gate passed but Fiscal's lint, which found
  the new e2e file unformatted after a last edit. It was formatted, and `npm run lint` and
  the catalogue e2e (10 of 10) were run again. The full run was not repeated.
  - Fiscal's unit tests: 174.
  - Fiscal's full e2e suite: 67. It includes the RLS guard on every table and Phase 41's
    rule tests, which now resolve through the catalogue-aware store.
- **`make demo` twice, `make test-alerts` and `make test-phase10`:** passed.
- **`deck`:** not run, since `gateway/kong.yml` did not change.
