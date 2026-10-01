# Phase O threat model

**Scope:** what Phase O (the tax rules engine, Phases 82–89) added:
- the shared catalogue of tax law and its adoptions;
- the formula language;
- the IBS/CBS oracle and the support matrix;
- the legacy taxes;
- estimates and the lock's event to the Ledger;
- the governance of rule changes.

**Basis:** the decisions are [ADR 0070](adr/0070-tax-law-is-a-shared-catalogue-that-workspaces-adopt.md)
to [ADR 0074](adr/0074-a-tax-rule-change-is-requested-and-approved-by-another-person.md), and
the plan is [the tax engine plan](tax-engine-plan.md).

Each row names the control, and the test or drill that proves it. The drill is
`scripts/phase-o-drill.mjs` ([record](drills/2026-10-01-phase89-drill.json)). A threat
without a proof is listed as open.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| The catalogue of tax law | Fiscal: `fiscal_catalog_packages`, `_rules`, `_references`; no tenant | Every workspace that adopts a package calculates with it |
| Adoptions and own rules | Fiscal: `fiscal_package_adoptions`, `fiscal_tax_rules` and their reviews and activations, under forced RLS | Decide the taxes on every later document of a workspace |
| Locked calculations | Fiscal: `fiscal_calculations`, the input sealed under a per-tenant key | What a document owes, and the proof of it; must replay byte for byte |
| The official calculator | `.artifacts/fiscal/rtc/<digest>`, pinned in the source manifest | The oracle the IBS/CBS packages are proven against |
| The support matrix | `fiscal/support-matrix.json`, generated from evidence | Decides what may be locked at all (ADR 0072) |
| The tax postings | Ledger: `tax-lock` transactions | What reaches the books from a lock |
| `FISCAL_ARTIFACT_KEY_HEX` | Fiscal's environment | Opens every sealed calculation input |

## Trust boundaries

1. **Publisher → catalogue.** Only the migration role writes the catalogue, from a CLI. The
   application role reads it.
2. **Workspace admin → `/fiscal/rule-changes` → another admin.** A change applies only when
   someone other than its requester approves it.
3. **The official calculator → `make tax-oracle` → a recorded run.** The calculator runs
   on 127.0.0.1 and is never reached by a request.
4. **Lock → `fiscal.calculation.locked` → Ledger.** The Ledger posts what the lock says,
   never an estimate.

## Threats and controls

### The five threats the Phase O plan names

| Threat | Control | Proof |
|---|---|---|
| **A tampered package:** bytes changed after review, or a rule rewritten in place | A package is named by its source's digest. Different bytes under the same digest are refused. Rules and references are immutable. The application cannot write the catalogue | `catalog.e2e-spec.ts` (*is read by the application and written by nobody through it*); the drill's `catalogueWriteByTheApplication` |
| **Oracle drift:** the official calculator changes, or the engine silently stops agreeing | The calculator is pinned by digest, and `make tax-oracle` refuses another one. Every run is recorded in Fiscal (`fiscal_tax_oracle_runs`). `TaxOracleDisagrees` fires on any difference, and `TaxOracleStale` after eight days without a run. The matrix is generated only from runs that agreed | `scripts/tax-oracle.mjs`; `phase-o.rules.test.yml`; the Phase 84 records (6,104 of 6,104 lines agreed) |
| **A rounding exploit:** splitting a sale into small lines so each line's tax rounds away | Each component is rounded once per line, as the NF-e states it. A document's tax is never more than half a minor unit per line from its exact total, and every line's amount is its own exact value rounded once | `rounding.property.spec.ts` (300 seeded documents) |
| **A stale adoption:** a workspace calculating with a version it has not reviewed, or a change applied without seeing its effect | Adoption is explicit and dated, and never automatic (ADR 0070). Every request carries the impact report on the locked documents of the last months. The approver decides on it, and approval applies only what still holds | `governance.e2e-spec.ts`; the golden path ([record](drills/2026-10-01-phase89-golden-path.json)) |
| **An override without a reason** | A rule change needs a reason of at least ten characters and a legal basis. An own rule cannot take the catalogue's `default` precedence. Every request and decision is audited | The drill's `ruleChangeWithoutReason`, `overrideProposalWithoutReason` and `ownRuleAtDefaultPrecedence` |

### Also

| Threat | Control | Proof |
|---|---|---|
| **Self-approval,** in person or through a delegation lent by the requester | The service refuses it (`segregation-of-duties`, `fiscal.rules`), and so does the database's trigger on any path | The drill's `selfApproval` and `selfRejection`; `governance.e2e-spec.ts` |
| **A role that should not decide:** an issuer asking, a viewer approving, an issuer lending the approval | `rules:manage` and `rules:approve` belong to the admin role alone. A delegate decides only through an active delegation | The drill's `issuerRequests`, `viewerApproves` and `issuerLendsTheApproval` |
| **A cross-tenant read** of another workspace's changes, rules or adoptions | Forced RLS on every governance table; the catalogue itself is shared and holds no tenant data | The drill's `crossTenantRead` and `crossTenantList` |
| **An unsupported scenario reaching the books** | The lock refuses what the support matrix does not cover (`UNSUPPORTED_SCENARIO`). Only Sales-origin locks are posted, and only the taxes in the price | `catalog.e2e-spec.ts`; the drill's `unreviewedScenario`; `postings.e2e-spec.ts` |
| **A lock that no longer replays,** after a restore, a key rotation or an interpreter change | A lock replays from its own stored rules, never from the catalogue. The worker replays a sample every ten minutes, and `TaxLockReplayFailed` fires on any failure | `phase-o.rules.test.yml`; the golden path's replay; the isolated record's replay after the next version |
| **A fact asserted to lower a tax** (a customer declared a reseller, an item not industrialized) | Facts come only from the revisions a person stated (the customer's fiscal profile, the item's classification). Readiness binds those revisions, and the audit logs of Parties and Catalog name who changed them | `party.spec.ts`; `catalog/test/database.e2e-spec.ts`; `estimates.spec.ts` |

## Open

- **Hypothetical rates are proven only in isolation.** The 2027 package was checked against
  the official calculator at nominal rates the Senate has not fixed. It is published only in
  the throwaway database of `scripts/phase-o-2027.mjs`
  ([record](drills/2026-10-01-phase89-isolated-2027.json)).
- **Facts are entered by API.** A screen for a customer's fiscal profile or an item's
  classification does not exist yet; the stated facts are as good as whoever states them.
- **The oracle's SLI depends on recording a run.** A CI run that is not recorded with
  `tax:oracle-record` shows as stale, not as disagreeing.
