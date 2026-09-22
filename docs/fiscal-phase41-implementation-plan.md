# Phase 41 — Temporal tax rules and explanations

Status: **in progress**. This is the execution plan for [Phase 41 in the fiscal roadmap](fiscal-implementation-plan.md#41--temporal-tax-rules-with-explanations). Phase 40 delivered the independent Fiscal service, immutable source packages and rule versions, tenant isolation and simulation drafts. Phase 41 adds reviewed reference data, deterministic calculations and explanations. Authority transmission remains outside this phase.

The first implementation increment publishes the versioned calculation input/outcome
contracts in `@horizon/contracts` 0.26.0 and adds the pure Fiscal calculation foundation:
canonical SHA-256 inputs/rules/results, exact rational arithmetic, explicit rounding,
legacy versus IBS/CBS grouping and source-backed explanations. Its fixtures are marked
illustrative; no scenario is enabled until the source and specialist-review gates below
are satisfied.

## Result and scope

Given a frozen fiscal input and an explicit calculation date, Fiscal selects one approved, effective rule set and returns the same canonical result on every replay. Each line and document total identifies its inputs, rule version, source artifact, formula, rounding and any reason a calculation is unsupported. A draft can become internally `validated` only when its frozen calculation is supported and persisted in the same transaction. Phase 42 will expose that condition as document `ready` in its issuance workflow.

The engine must distinguish **legacy** tax components from **IBS/CBS** components. It must not infer a rate, classification, exemption or zero amount from a missing source. Initial supported scenarios are a specialist-approved fixture matrix, starting with NF-e model 55 in simulation. Other models and operations may be represented as reference data but remain `unsupported` until their own rules and fixtures are approved. No live SEFAZ/NFS-e call, XML authorization, stock movement or financial posting is part of a calculation or preview.

## Starting point and source gate

- `fiscal_source_packages` and `fiscal_rule_versions` already exist in [migration 0007](../fiscal/migrations/0007_phase40_reference_and_imports.sql). They are append-only and tenant-scoped, but do not yet store activation/review evidence or prevent equal-priority overlaps.
- [Fiscal documents](../fiscal/src/documents.ts) already freeze encrypted Sales origin data. The [lifecycle](../fiscal/src/lifecycle.ts) uses `draft -> validated -> submitted` internally; public `/documents/:id/validate` and `/issue` remain disabled. Phase 41 must connect `validated` to a persisted calculation without enabling issuance.
- [Money](../contracts/src/common.ts) is an integer number of minor units encoded as a string; quantity is a decimal string with at most six places. Tax rates and unit prices need an equally explicit scaled-decimal contract.
- The [source register](fiscal-source-register.md) has baseline NF-e/NFS-e artifacts, but its IBS/CBS rule package and tax review are pending. A checksum proves which bytes were used; it does not approve a legal interpretation. The Receita [NCM download page](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/download-ncm-nomenclatura-comum-do-mercosul) says its current table omits past and future codes, so historical imports must be retained. The [national NFS-e technical library](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual) publishes service and IBS/CBS annexes that must likewise be pinned by artifact and version.

Before any scenario becomes supported, record the source URL, exact downloaded bytes and SHA-256, publication and effective dates, environment/jurisdiction, reviewer, review date, interpretation, fixture IDs and superseded package. Obtain a fiscal specialist's approval for rate tables, regime/operation mapping, rounding and source applicability. If an official artifact cannot be obtained or interpreted, keep that scenario `unsupported` and surface the missing prerequisite. Update the [source register](fiscal-source-register.md) with the approved package; do not use publication date as the rule's effective date.

## Work packages and order

| Step | Deliverable | Dependencies | Evidence |
|---|---|---|---|
| 1. Source inventory and scenario matrix | Frozen official artifacts and a reviewed matrix keyed by model, issuer regime, operation, origin/destination, jurisdiction and date. Each row names expected components and unsupported cases. | Source gate | Reviewer identity, package digest and fixture sign-off recorded. |
| 2. Reference imports | Validated imports for CFOP, NCM/CEST, CST/CSOSN, IBS/CBS and service classifications, with provenance, validity windows and retained history. | 1 | Reimport is idempotent; changed bytes create a new package; malformed or conflicting rows are rejected. |
| 3. Profiles and rule resolution | Versioned issuer, item, party and operation facts; precedence, overlap detection, effective-date lookup and explicit ambiguity/missing errors. | 1–2 | Boundary and precedence tests with two tenants and historical package activation. |
| 4. Pure calculation core | Canonical input/result contracts, integer/rational arithmetic, line/document allocation, component explanations and stable digests. | 1–3 | Specialist-reviewed golden fixtures and deterministic replay/property tests. |
| 5. Persisted calculation | Append-only calculation snapshot bound to a document and its rule/package digests; validation guard and override audit. | 3–4 | Database tests for immutability, concurrency, RLS and replay after activation of a successor. |
| 6. API and read surfaces | `POST /fiscal/calculations/preview`; read-only calculation/explanation endpoints; explicit problem codes. | 4–5 | Auth/API tests prove no preview writes, outbox events or authority calls. |
| 7. Local rollout | Migrations, reviewed package import, replay comparison, release evidence and rollback procedure. | 1–6 | `make ci-local`, migration/integration checks and local Docker smoke evidence. |

Steps 1 and 2 can start together for source families whose artifacts are available. Rule activation and any supported fixture depend on the specialist review. A package can be imported for inspection while every scenario remains unsupported.

### Expected code changes

| Area | Planned change |
|---|---|
| `fiscal/migrations/0010_*` onward | Add reviewed activation, reference/profile rows, calculation snapshots and binding constraints without rewriting migrations 0001–0009. |
| `fiscal/src/ports.ts` and new `fiscal/src/rules*` modules | Extend `RulePackageRepository` beyond digest lookup; add source import, temporal resolution and activation services. |
| New `fiscal/src/calculation*` modules | Keep canonicalization, exact decimal arithmetic, pure formulas, explanation rendering and replay checks separate from HTTP and persistence. |
| `fiscal/src/documents.ts`, `lifecycle.ts`, `api.ts`, `auth.ts` | Bind a calculation at validation, enforce the submission guard, expose preview/read endpoints and apply permissions. |
| `contracts/src/` | Publish versioned input, result, explanation and problem schemas; bump the contracts version and update exact pins in consumers. |
| `fiscal/test*` and `docs/` | Add reviewed fixtures, unit/API/PostgreSQL tests, source-register entries and a Phase 41 evidence record. |

## Contracts and selection rules

### Canonical input

Define a versioned `CalculationInput` in `@horizon/contracts` and a strict parser in `fiscal/`. Required facts: tenant and issuer establishment; document model/environment; operation and purpose (including return reference where applicable); issuer/recipient regimes and relevant jurisdiction codes; origin/destination; issue date and, where a source requires it, competence date; currency; immutable line IDs, quantity, scaled unit price, discounts/charges, product/service classifications and tax-relevant party facts. Keep personal data in the existing encrypted document snapshot; expose only the minimum facts needed by authorized read APIs.

Dates are calendar dates for rule selection, never UTC instants converted through a timezone. The approved scenario matrix must state which date controls each component and how a boundary day is treated. Reject invalid dates, negative values outside an explicitly reviewed return formula, over-precision values and mismatched currencies with stable problem codes.

Represent quantity and unit price as decimal strings with declared scale, rates as numerator/denominator or fixed-scale decimal strings, and amounts as `Money`. Use `bigint`/integer arithmetic end to end; never parse tax values through JavaScript `number` or floating-point `Math.round`. Define one canonical JSON encoding with stable field order, normalized decimals and explicit schema version before hashing or byte comparison.

### Reference data and precedence

Use the Phase 40 package/version tables as the immutable source anchors. Add normalized reference entries and profile/rule tables in a forward migration; every row carries tenant, package/version, source row or section, effective half-open interval `[from, to)`, applicable model/jurisdiction and digest. Preserve old packages and classifications for historical replay. Activation is a separate audited pointer/state change: import → validate → review → activate, never update a rule definition in place. An activation cannot silently change a calculation already bound to a document.

Resolve profiles in a documented order: exact operation override, issuer/establishment, item or service, party, then reviewed jurisdiction/model default. More specific conditions win only when the precedence schema says so; a default must itself be a reviewed rule. At a given priority and date, two matching rules are an error. Reject overlapping equal-priority intervals at write/activation time and retain a runtime ambiguity guard. Explicit exclusions and exemptions need a source and explanation; absence of a match yields `UNSUPPORTED_RULE`, not a zero rate. Cross-tenant references and a reference code outside its effective window are invalid.

The resolution trace records candidates considered, the winning rule IDs and versions, precedence reason and rejected alternatives without exposing protected party details. Separate `published_at`, `effective_from`, `imported_at` and `activated_at`; do not use the latest package as a substitute for the package selected at the original calculation.

### Calculation and explanation

Make the calculation function pure: `calculate(input, resolvedRules) -> result | typed unsupported result`. It performs no I/O, reads no clock or active package pointer, and receives all effective rules explicitly. For each component, record base, rate, reductions/exemptions, unrounded rational amount, rounded `Money`, formula identifier, rounding mode/scale, source URI/section and rule ID/version. Return legacy and IBS/CBS component groups separately, line totals, document totals and a reconciliation proof that sums and allocations match. Define rounding at component/line/document boundaries in the reviewed matrix; allocate residual minor units by stable line ID if a source requires document-level rounding. Negative returns and discounts have explicit reviewed formulas rather than reused sale defaults.

The human explanation is derived from structured result fields and a versioned template. Store both the structured trace and rendered explanation/template version so wording changes do not break historical byte replay. Stable `inputDigest`, `rulesDigest` and `resultDigest` cover canonical bytes. A replay routine loads the stored input and exact rule versions, recalculates and compares canonical result bytes/digests; a mismatch is an integrity error, never an automatic rewrite.

### Frozen document and exception path

Add append-only `fiscal_calculations` (or an equivalent append-only table) with tenant/document ID, input ciphertext/digest, selected rule-version IDs and package digests, canonical result/digest, explanation version, actor, created time and optional predecessor ID. Use forced RLS, tenant-composite foreign keys, unique current calculation binding and immutable-row triggers. Reuse the Phase 40 snapshot encryption/key discipline. A draft edit creates a successor document or calculation proposal; it cannot mutate a frozen/posted calculation. A successor must link to its predecessor and reason.

For this phase, treat existing internal `validated` as the calculation-locked state. Make the `draft -> validated` transaction insert or select one identical calculation, verify its digest and supported status, then append the transition and audit. Concurrent retries must return the same binding; conflicting attempts fail. Require this binding before any later submit path can run. Phase 42 can expose `ready` in its public lifecycle and migrate/rename the internal state if needed, while retaining the invariant.

An override is a separate, explicitly permitted command restricted to `rules:manage` (or a narrower dedicated permission if the role review requires it), with actor, reason, before/after values, source basis and audit entry. It creates a successor rule/calculation proposal; it never edits a posted row or bypasses the supported-scenario gate. A reviewer can inspect the request but cannot approve their own exception if the reviewed workflow requires separation of duties. No override permits transmission until the exact scenario has been reviewed and enabled.

## HTTP surface

- `POST /fiscal/calculations/preview`: authenticated and tenant-scoped. Accept a complete versioned input or a tenant-owned draft ID; never trust a caller's tenant ID or replace frozen Sales facts. Return `supported`, canonical totals/components, input/rule/source digests and explanations. For unsupported input, return a typed problem (`UNSUPPORTED_RULE`, `MISSING_CLASSIFICATION`, `AMBIGUOUS_RULE`, `SOURCE_NOT_APPROVED` or `INVALID_FISCAL_INPUT`) with the missing dimension; no guessed amount. Apply body/line limits and no-store caching.
- `GET /fiscal/documents/:id/calculation` and `GET /fiscal/documents/:id/calculation/explanation`: read permission, tenant-scoped, redacted where necessary. Return the frozen result and source references, not arbitrary ciphertext or certificate material. The explanation endpoint may render from saved template/version but must not select today's rules.
- Internal validate/lock command: `transmission:submit` or a dedicated validation permission, idempotency key and digest check. Keep public `/documents/:id/validate` disabled until the Phase 42 workflow is ready; internal simulation tests may exercise the invariant.

Define schemas and examples in `@horizon/contracts`; keep API error identifiers stable and document field meanings. Preview may read approved source/rules but performs no insert/update, emits no outbox or operational event, reserves no number and calls no authority gateway. Add a test with spies and database row counts for those guarantees.

## Verification matrix

The fixture corpus lives in `fiscal/` with source package digest, reviewer, expected canonical input and result, formula/explanation references and approval status. Distinguish illustrative fixtures from approved legal fixtures; only approved fixtures enable a supported scenario. Cover at least:

| Risk | Required fixture/test |
|---|---|
| Temporal selection | Day before, first and last day of a validity interval; successor activation; replay of the older date after activation. |
| Scope and precedence | Same code in two tenants; issuer/item/party/operation conflicts; equal-priority overlap rejected; no matching rule. |
| Fiscal dimensions | Intra- and interstate operations, return/reference, regime change, missing/expired NCM/CEST or service code, unsupported model/jurisdiction. |
| Arithmetic | Fractional quantity, discounts/charges, half-way rounding, very large values, negative return, line-to-document residual allocation and currency mismatch. |
| Preservation | Draft lock race, idempotent retry, conflicting digest, immutable rows, encrypted input, cross-tenant read/write denial and audit chain. |
| Isolation | Preview performs no write/event/number reservation/authority call; unsupported result blocks validation and any future submission. |

Compare complete canonical result bytes and digests, not just totals. Add focused property tests for sum/reconciliation and deterministic ordering, plus PostgreSQL Testcontainers integration tests for constraints, RLS and replay. A specialist signs expected legal results separately from automated test success. Record the exact source and fixture revisions used by CI.

## Rollout and exit evidence

1. Apply additive migrations in the local Docker stack; keep old documents readable. Import packages in a staged state and verify digests, counts, validity ranges and rejected rows before activation. Do not backfill invented calculations for Phase 40 drafts: preview them, flag missing facts/sources and lock only those with approved inputs.
2. Activate one reviewed simulation scenario at a time. Compare previews against the approved corpus and replay every newly locked calculation. Record activation actor/time and package version; monitor unsupported/ambiguous outcomes without logging protected input.
3. Run Fiscal typecheck/unit/integration tests, repository checks and `make ci-local`; smoke-test preview and frozen explanation through Kong with an authorized role, and confirm public issuance still returns unsupported. Capture SQL counts, package digests, fixture sign-off and command results in a Phase 41 evidence record.
4. Roll back by deactivating the new package pointer/feature exposure, retaining immutable packages and calculations. Never delete historical versions or rewrite a posted calculation. A correction is a successor with audit and review.

Phase 41 is complete only when approved supported fixtures are byte-for-byte replayable, each returned amount has a source and explanation, equal-priority ambiguity is rejected, unsupported scenarios cannot become validated or submitted, no floating-point tax path exists, preview has no side effects, and the local rollout and evidence record pass. If specialist approval or an official source artifact is unavailable, keep the affected scenarios unsupported and record that blocker; do not mark the phase delivered.
