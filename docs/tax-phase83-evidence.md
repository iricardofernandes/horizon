# Phase 83 evidence — The formula language and its interpreter

[Plan](tax-phase83-implementation-plan.md) · [Phase O plan](tax-engine-plan.md) ·
[ADR 0071](adr/0071-tax-formulas-are-data-over-a-closed-vocabulary.md)

## What was delivered

- **`fiscal/src/formula.ts` (`formula-v1`).** A rule's expression builds its base from:
  - the line: gross, discount, charges, net, quantity, signed as the line is;
  - other components' rounded amounts;
  - rational constants.

  The operations are sum, product, gross-up, reduction, minimum and maximum. The limits are
  depth 8 and 64 nodes. There is no code, no loop and no conditional.
- **The amount is `round(round(base) × rate)`,** with the rule's own rate. An outcome of
  `exempt`, `suspended`, `deferred` or `not-levied` keeps the base and owes nothing.
- **Components are evaluated in dependency order.** A formula reading a component that the
  line does not select answers `UNSUPPORTED_RULE`, naming `component:<CODE>`.
- **Refused when a package is published to the catalogue or imported by a workspace,**
  never when a document is calculated:
  - a cycle;
  - a self-reference;
  - an unknown component;
  - an unknown node;
  - an extra key;
  - an oversized tree.
- **Explanations:**
  - an expression component records `formula: EXPRESSION`, its `outcome`, and five named
    steps: the base, the rounded base, the rate, the base times the rate, and the rounded
    amount;
  - the rule set is explained as `fiscal-explanation-v2` when any selected rule is an
    expression;
  - rule sets without an expression take exactly the v1 path, digests included.
- **Storage:** migration `0055_phase83_expressions.sql` adds `expression` to workspace and
  catalogue rules. The database holds the formula and the expression together.
- **`exact-decimal.ts`** gains `subtract`, `divide` and `compare`.
- **Contracts 0.53.0:**
  - the optional `outcome` and `steps` on a tax component, an additive change;
  - every consumer is pinned;
  - the published tarball rebuilds byte for byte and matches every lockfile's integrity.

## Proof

- **Unit tests (`formula.spec.ts`), 17:**
  - every node;
  - a gross-up at a rate of one refused;
  - unknown nodes, extra keys, depth and size refused;
  - rendering;
  - the four non-levied outcomes;
  - evaluation order;
  - cycles, self-reference and unknown components.
- **Property tests:** 1,000 seeded cases each, with no new dependency.
  - An expression over a line always gives the same value.
  - A grossed-up base, less its own rounded tax, comes back to the original within one minor
    unit.
  - A reduction by zero and a product by one are identities.
  - Every value is an exact rational.
- **Phase 41's rules as expressions** (`{ "line": "net" }`) give the approved bases, rates,
  amounts and totals. The result digest differs, as it must, because the formula and its
  steps are recorded. The golden fixture keeps reproducing byte for byte with the v1 rules.
- **Tax on tax,** worked on the fixture's line (net BRL 100.00):
  - IPI at 10% gives 10.00;
  - ICMS at 18% over `grossUp(net + IPI, 18/100)` has a base of 13414.63…, rounded to
    134.15, and gives 24.15;
  - the rules are evaluated in that order although they arrive in the other one;
  - the explanation shows `base = grossUp((line.net + IPI), 18/100)`.
- **e2e (`catalog.e2e-spec.ts`), 13 in all, 3 new:**
  - a catalogue package whose components read each other in a cycle is refused when
    published;
  - an expression package is published, adopted and previewed through the store, with the
    same amounts and steps as the unit test;
  - a workspace import whose formula reads an undefined component is refused.
- **The whole Fiscal e2e suite:** 70 of 70. Unit tests: 191 of 191.
- **On the stack,** after migration 0055:
  - Phase 41's fixture still gives input `c68492b3…`, rules `25ade44c…` and result
    `256201c9…` from the catalogue;
  - **all 95 locked calculations replay**, every one of them v1.

## Not done, stated

- **Document-level rounding is not offered to expressions.** Phase 41's
  `DOCUMENT_NET_TIMES_RATE` keeps it. An expression rounds per line.
- **Partial deferral** (a percentage of ICMS deferred) is not an outcome. It can be written
  as a reduction, and whether that is the right reading is Phase 85's to decide with its
  fixtures.
- **Freight, insurance and other expenses are not separate line values,** since the input
  carries them together as `charges`. Separating them is a contract change for Phase 85, if
  its scenarios need it.

## Verification (2026-09-30)

- **`node scripts/ci-local.mjs --full`** passed in full: every module, clean installs, the
  contract gates and every image. Fiscal ran 191 unit tests and 70 e2e.
  - A first run was interrupted, and a leftover image build wrote into its log, so it was
    run again from the start.
- **`make demo` twice, `make test-alerts` and `make test-phase10`:** passed.
- **`deck`:** not run, since `gateway/kong.yml` did not change.
