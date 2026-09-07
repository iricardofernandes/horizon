# Roadmap — declared future scope

This document is the counterpart to [plan.md](plan.md). Everything here is
**intentionally not built yet and has no folder in the repository.** A directory
appears when its phase begins; an empty directory would read as abandonment, and a
roadmap entry reads as sequencing.

Each entry states the problem it solves, why it was deferred, and what would have to
be true before it starts.

---

## `financial/` — accounts payable and receivable

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

## `fiscal/` — a versioned multi-regime tax rules engine

**Problem it solves.** Tax calculation in Brazil is currently undergoing a
constitutional reform in which two tax regimes coexist for several years: the
existing regime and the new IBS/CBS regime, phased in on a published schedule with
overlapping rates. A document issued on a given date, for a given pair of
jurisdictions, under a given taxpayer classification, must be calculated under
whichever regime — or blend of regimes — applies at that moment.

Framed universally, and this is how it will be documented: **a rules engine that
evaluates versioned, temporally-scoped, jurisdiction-scoped rule sets, where two
independent rule sets are simultaneously in force during a multi-year transition,
and where a historical document must be recalculable exactly as it was calculated on
its original date.** That is a genuinely hard versioning and determinism problem,
and it is legible to a reviewer who has never heard of the Brazilian tax code.

**Scope when built.** The calculation engine only:

- Rules expressed **as data** — versioned rule sets with validity intervals,
  jurisdiction scope, and taxpayer-classification predicates — never as branching
  conditionals in code. A rate change is a new rule row, not a deployment.
- Deterministic recalculation: the same document and the same effective date always
  produce the same result, including years later, because the engine resolves the
  rule set version rather than "the current rules".
- A SEFAZ port with a **deterministic mock adapter as the default**, so the module is
  fully testable and fully demonstrable with no external dependency and no
  certificate.
- A calculation-explanation output: which rule versions fired, in what order, with
  what intermediate values. A tax result that cannot be explained is not usable.

**Why deferred.** It is the most domain-heavy module in the system and the least
transferable: a reviewer cannot judge its correctness without Brazilian tax
knowledge. Its engineering value depends entirely on the framing above, and that
framing is only credible once the surrounding architecture is visibly solid. Built
early, it would be the largest and least legible thing in the repository.

**Preconditions.** `sales/` emitting invoicing triggers (Phase 7); `catalog/` NCM
classification in place (Phase 6); the contract versioning gate live, since fiscal
rule schemas will version faster than anything else (Phase 3).

**Known omissions to declare when built.** SPED export and digital-certificate
handling (A1/A3) will be explicitly out of scope and documented as such. Half of a
certificate integration is worse than none — it invites a reviewer to assume the
whole document-transmission path works when it does not.

---

## `tooling/mcp-agent/` — a customer-facing MCP server

**Problem it solves.** A tenant wants their own AI agent to query their own ERP
data. The naive implementation gives the agent a privileged service account, which
means the agent can read every tenant's data and the audit trail records the service
account rather than the person.

**Scope when built.** An MCP server that a tenant's agent connects to using **an API
key issued through the existing model in §3** — the same key format, the same
explicit scope list, the same per-key rate limits at Kong, the same `tenant_id` in
the request context, the same RLS policies, the same audit entries naming the key
and therefore the person who issued it.

**Why it matters more as a security argument than as a feature.** The point is the
absence of a privileged path: there is no agent-specific bypass, no elevated role, no
"the model needs broader access to be useful". If an agent can read it, a human with
that key could have read it, and the audit log will say so. Any design that cannot
make that statement is not shippable.

**Why deferred.** It requires the API key scope model, RLS, and the audit chain all
to be real and tested (Phase 4), a business surface worth querying (Phases 6–7), and
the read-only MCP discipline already established internally by
`tooling/mcp-debugger/` (Phase 12).

**Preconditions.** Phases 4, 6, 7 and 12 complete.

---

## RAG over tenant documents

**Problem it solves.** Tenants accumulate documents — contracts, purchase orders,
correspondence — and want to ask questions across them.

**The isolation requirement, stated now so it is not retrofitted.** Retrieval must be
scoped by `tenant_id` **at the index level**, not by filtering results after
retrieval. Post-filtering means a vector search ranks across every tenant's content
and then discards what it should never have scored; it leaks through ranking
behaviour, through latency, and through any bug in the filter. The design must use
per-tenant indexes or a store with enforced partition-level scoping, so that a query
issued in tenant A's context is structurally incapable of touching tenant B's
vectors — the same guarantee RLS gives the relational store.

Stating this before any code exists is the entire reason the entry is here. It is the
kind of constraint that is cheap now and expensive after an index exists.

**Why deferred.** There are no tenant documents to index until the ERP is in use, and
an embedding pipeline built against synthetic data proves nothing.

**Preconditions.** Document storage in a business module; the tenant context
propagation of Phase 4; a decision, recorded as an ADR, on the vector store and its
partitioning guarantees.

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

**Preconditions.** Real usage; a completed data-protection assessment; an ADR that
picks one of the three options above and says why.
