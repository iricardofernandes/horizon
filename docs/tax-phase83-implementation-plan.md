# Phase 83 — The formula language and its interpreter

Status: **delivered on 2026-09-30** ([evidence](tax-phase83-evidence.md)). The second phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O), implementing [ADR 0071](adr/0071-tax-formulas-are-data-over-a-closed-vocabulary.md).

## Result

After this phase:
- **A rule may carry an expression** instead of one of Phase 41's three fixed formulas. The
  expression says how the component's **base** is built:
  - from line values (gross, discount, charges, net, quantity) and other components'
    amounts;
  - with sum, product, gross-up, reduction, minimum and maximum over rational constants.

  The rule's own rate then applies to that base.
- **An outcome other than an amount is a value.** Exempt, suspended, deferred and not
  levied keep the base and give an amount of zero, and the result says which.
- **Components can depend on each other in a line,** such as ICMS over a base that includes
  IPI. They are evaluated in dependency order.
- **A package with a cycle, an unknown component or an oversized expression is refused when
  it is published or imported,** never when a document is calculated.
- **Every step is explained:** the base before and after rounding, the rate, and the amount
  before and after rounding. Results that use an expression are explained as
  `fiscal-explanation-v2`. Results without one stay exactly as before, v1, digests
  included.

## Starting point (checked on 2026-09-30)

- `calculation.ts` knows three formulas.
  - `LINE_NET_TIMES_RATE`, and `RETURN_LINE_NET_TIMES_RATE` for returns: the line's net
    times the rate, rounded half away from zero.
  - `DOCUMENT_NET_TIMES_RATE`: the same, with the document's rounding residual allocated
    across lines.
- A component carries its code, base, rate, unrounded amount, amount, formula, rounding,
  rule and source. The explanation is one line of text per component.
- The contract (`fiscalCalculationResultSchema`) parses the result and drops any field it
  does not declare.
- `exact-decimal.ts` has `add`, `multiply`, `reduce` and rounding. It has no subtraction and
  no division, which a gross-up needs.
- Rule tables (a workspace's and the catalogue's) check `formula` against the three names,
  and hold a rate on every row.

## Decisions

1. **An expression defines the base; the rule's rate stays where it is.**
   - The amount is `round(round(base) × rate)`: the base is rounded to the minor unit
     first, as fiscal documents state it, then taxed.
   - A rule with `formula: EXPRESSION` carries `expression: { base, outcome? }` in a new
     `expression` column (JSON), and still carries its rate in the rate columns.
2. **The vocabulary** (`fiscal/src/formula.ts`, versioned `formula-v1`):

   | Node | Meaning |
   |---|---|
   | `{ "line": "gross" \| "discount" \| "charges" \| "net" \| "quantity" }` | A line value, signed as the line is (a return is negative) |
   | `{ "component": "<CODE>" }` | Another component's rounded amount on the same line |
   | `{ "rate": { "numerator", "denominator" } }` | A rational constant |
   | `{ "sum": [ … ] }`, `{ "product": [ … ] }` | Two to eight operands |
   | `{ "grossUp": { "base", "rate" } }` | `base / (1 − rate)`, the base "por dentro" |
   | `{ "reduce": { "base", "by" } }` | `base × (1 − by)`, a base reduction |
   | `{ "min": [ … ] }`, `{ "max": [ … ] }` | Two to eight operands |

   - Outcomes: `levied` (the default), `exempt`, `suspended`, `deferred`, `not-levied`.
   - Limits: depth 8, 64 nodes.
   - Division by zero is impossible by construction, since a gross-up rate must be below 1.
     It is still refused at evaluation.
3. **Validation when a package is published or imported:**
   - the schema;
   - the limits;
   - every `component` reference names a component some rule of the package defines;
   - the references between the package's components form no cycle.
4. **At calculation:**
   - a line's selected components are ordered by their references;
   - a reference to a component not selected for that line answers `UNSUPPORTED_RULE`,
     naming `component:<CODE>`;
   - v1 formulas keep their exact behaviour, including document-level rounding;
   - document-level rounding is not offered to expressions in this phase.
5. **The result:**
   - an expression component records `formula: "EXPRESSION"`, its `outcome`, and `steps`
     (named rational values);
   - the rule set records `fiscal-explanation-v2` when any selected rule is an expression;
   - these fields are optional in the contract, so v1 results parse and digest as before.
6. **Contracts 0.53.0:** the optional `outcome` and `steps` on a tax component. This is an
   additive change, a minor bump, and every consumer is pinned.

## Proof

- **Unit tests (`formula.spec.ts`):**
  - each node;
  - the limits;
  - cycles and unknown references;
  - the outcomes;
  - explanations.
- **Property tests (seeded, no new dependency):**
  - the same expression and line give the same digest;
  - a gross-up followed by applying its rate returns the base within one minor unit;
  - a reduction of 0 and a product by 1 are identities;
  - no evaluation produces anything but a rational.
- **Phase 41's three rules, rewritten as expressions (`{ "line": "net" }`),** give the
  approved bases, rates and amounts. The result's digests differ, as they must: the
  formula and its steps are part of what is recorded. The golden fixture itself still
  reproduces byte for byte with the v1 rules.
- **A worked example with tax on tax:**
  - IPI at 10% of the net;
  - ICMS at 18% over a base of net plus IPI, grossed up;
  - both explained step by step, and calculated in that order whatever order the rules
    come in.
- **e2e:**
  - a catalogue package with a cycle is refused when published;
  - an expression package is published, adopted and previewed through the store;
  - a workspace import with an unknown component is refused.
