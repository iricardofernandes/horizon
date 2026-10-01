# Roadmap — declared future scope

This document is the counterpart to [plan.md](plan.md). Everything here is
**intentionally not built yet and has no folder in the repository.** A directory
appears when its phase begins; an empty directory would read as abandonment, and a
roadmap entry reads as sequencing.

Each entry states the problem it solves, why it was deferred, and what would have to
be true before it starts.

**Built, and moved out:** the customer-facing MCP server and RAG over tenant documents,
in [Phase N](ai-implementation-plan.md) (Phases 71–78). The MCP server became `agent/`
(ADR 0065), not `tooling/mcp-agent/`. The index is `knowledge/`, one pgvector partition per
tenant (ADR 0067). Both entries' statements are its acceptance tests, proven by the
[Phase N golden path](drills/2026-09-29-phase-n-golden-path-ai-on.json) and
[drill](drills/2026-09-29-phase-n-drill-ai-on.json).

**Built, and moved out:** the versioned multi-regime tax rules engine, in
[Phase O](tax-engine-plan.md) (Phases 82–89).
- Tax law is a shared catalogue of immutable packages that workspaces adopt through a
  request another person approves (ADRs 0070 and 0074).
- Formulas are data over a closed vocabulary (ADR 0071).
- A scenario is supported only with evidence, the official calculator's agreement or an
  approved fixture (ADR 0072).
- Estimates appear where money is decided, and only the lock reaches the books (ADR 0073).
- The entry's statements are its acceptance tests, proven by the
  [Phase O golden path](drills/2026-10-01-phase89-golden-path.json), the
  [isolated 2027 record](drills/2026-10-01-phase89-isolated-2027.json) and the
  [drill](drills/2026-10-01-phase89-drill.json).
- SPED, apuração, guides, split payment and real transmission stay outside it.

---

## `financial/` — accounts payable and receivable

> Superseded as an implementation outline by the dependency-ordered
> [operational ERP expansion plan](erp-expansion-plan.md). That plan splits this broad
> placeholder into `financial/`, `treasury/` and `ledger/` boundaries and adds the
> prerequisite shared-party model, frontend localization and Developers information
> architecture.

**Problem it solves.** Every order that `sales/` confirms eventually becomes money
owed or money owing. Without a financial module, Horizon models commerce but not its
consequences: there is nowhere to record a receivable, match a bank line against it,
or close a period.

**Scope when built.** Accounts payable and receivable, bank accounts, statement
import and reconciliation, chart of accounts, and double-entry postings driven by
events published by `sales/` and (later) `fiscal/`.

**Why deferred.** It is a *consumer* of events, not a producer of new architecture.
Building it before the golden path exists would add a fourth service to a system
whose cross-service story was not yet proven, and its interesting engineering —
reconciliation matching, period close, immutable postings — is business complexity
rather than distributed-systems complexity. Horizon's purpose is to demonstrate the
latter first.

**Preconditions.** `sales/` publishing stable, versioned events (Phase 7); the
outbox/inbox pattern proven under duplicate delivery (Phase 7); the audit hash chain
in place, since financial postings are the strongest case for append-only storage
(Phase 4).

**Known omissions to declare when built.** Multi-currency consolidation and
accounting-standard conformance (IFRS/CPC) are out of scope; the module records
postings, it is not a certified ledger.

---

## Fine-tuning

**Problem it would solve.** Domain-specific behaviour — classifying a purchase
description to an NCM code, mapping a bank statement line to a chart-of-accounts
entry — where a fine-tuned model may outperform prompting.

**Why deferred.** There is no usage data. Fine-tuning without it is guessing, and a
portfolio project that claims a fine-tuned model with no dataset behind it is worse
than one that does not.

**What data would be needed.** Labelled pairs produced by real users making real
corrections: the suggestion offered, the correction applied, the tenant's segment.
Realistically tens of thousands of examples per task before fine-tuning beats a
well-prompted current model.

**What §6 implies about using it.** This is the constraint that makes the entry worth
writing down. Training data drawn from tenant records is personal data under LGPD and
GDPR, and Horizon's erasure mechanism is **crypto-shredding** — destroying a data
subject's key makes their stored plaintext unrecoverable. Model weights are not
encrypted with that key. A model trained on a subject's data does not forget them
when the key is destroyed, so the erasure guarantee would be quietly broken by the
existence of the model.

Therefore any future fine-tuning must satisfy, before a single example is collected:

- an explicit, separately-recorded lawful basis for training, distinct from the basis
  for operating the ERP;
- de-identification before the training set is assembled, such that no example is
  attributable to a data subject and erasure of that subject changes nothing about
  the model;
- or, failing both, a documented retraining cadence with a stated maximum window
  between an erasure request and a model that no longer reflects it — and an honest
  statement that the window is not zero.

If none of those can be met, the answer is not to fine-tune. That conclusion is
recorded here rather than discovered later.

**What Phase N collects, and does not.** Phase 77's suggestions record each acceptance or
rejection only as a counter, per kind (`knowledge_suggestion_decisions_total`), with no
tenant, no person and no example. There is no training set, and none is being built.
The workspace's confirmed history that suggestions read lives in `knowledge/`'s
per-tenant partitions, and leaves with its source (ADR 0068).

**Preconditions.** Real usage; a completed data-protection assessment; an ADR that
picks one of the three options above and says why.
