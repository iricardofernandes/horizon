# Phase 77 evidence — Suggestions confirmed by a person

[Plan](ai-phase77-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#77--suggestions-confirmed-by-a-person) ·
smoke records: [with the local model](drills/2026-09-29-phase77-suggestions-smoke.json),
[without the `ai` profile](drills/2026-09-29-phase77-suggestions-off.json) ·
[module README](../knowledge/README.md)

## What was delivered

- **Suggestions in `knowledge/`,** served through Kong:
  - `GET /knowledge/suggestions/ncm` needs a Catalog role;
  - `GET /knowledge/suggestions/payable-category` needs a Financial read role;
  - `POST /knowledge/suggestions/decisions`.
- **The confirmed history,** from events, in `examples PARTITION BY LIST (tenant_id)`:
  - `ensure_example_partition` gives each tenant its own partition, with its HNSW index and
    forced RLS;
  - items come from `catalog.item.created` and `classification-changed`;
  - payables come from `financial.payable.posted`: the supplier's name and the description
    are read through Kong as the `knowledge` service client, a Financial viewer since
    Phase 74;
  - `financial.payable.reversed` and `parties.party.erased` take examples out;
  - each event is handled once, through the inbox.
- **The official NCM table:**
  - `scripts/build-ncm-table.mjs` turns the Siscomex public download into
    `knowledge/data/ncm-table.json.gz` (244 KB). It holds 10,515 eight-digit codes in
    force on 29/09/2026 under Resolução Gecex nº 926/2026, each described with its heading
    and subheadings;
  - a background worker embeds it into `ncm_codes` once per act and embedder, retrying
    until the model answers. With e5 it loaded in about a minute, and a restart found it
    current.
- **Ranking:**
  - confirmed examples vote by similarity, within the embedder's example distance, the same
    supplier counting more;
  - official codes vote at half weight, and only when no example does;
  - at most three suggestions, each with its reason: the records it came from, or the
    official table.
- **Availability:** `KNOWLEDGE_SUGGESTIONS=auto` answers only with the `tei` embedder.
- **Web:** a suggestion chip under Catalog's NCM field and under Financial's category
  select. "Use" fills the field, and "✕" dismisses it; both post the decision. pt-BR and
  en.
- **Metrics:** `knowledge_suggestion_seconds{kind,outcome}` and
  `knowledge_suggestion_decisions_total{kind,decision}`.

## Exit evidence

| Criterion | Proof |
|---|---|
| Accepting a suggestion produces the same record and audit entry as typing it | A suggestion never writes: "Use" fills the form's own field, and the person saves through Catalog's or Financial's form. Smoke: an item saved with the suggested NCM and one typed leave `catalog.item.created` entries with the same actor, the same detail keys and the same NCM. Browser: "Use" filled NCM `0901.21.00`; on a new payable it set the category to MP77, and the draft saved through the normal form |
| A tenant's history never feeds another tenant's suggestions | e2e: the plan of a tenant's neighbours names only `examples_<tenant>`; another tenant's canary item never votes, and in its own tenant it comes first. Smoke: a second workspace's item "Chá mate canário…" never appears, by value or by source, in the first workspace's answer to its exact name |
| With the `ai` profile off, the screens work and show no suggestion | Smoke `--expect-off` on the stack's default (hash) embedder: the route answers `available: false` with no suggestion, and the form shows nothing. Web units: an answer with suggestions off shows no chip. A failed or refused request shows none either, and never blocks saving |

### Also proven

- **History first** (smoke, e5): "Café torrado em grãos 1kg" got `0901.21.00`, with
  "Café torrado em grãos 500g" as its reason.
- **The fallback:** a name the workspace never classified got official codes only, not the
  workspace's unrelated coffee item.
- **The supplier counts:** a payable for a known supplier got that supplier's category,
  with `sameParty: true` in the reason (smoke). In e2e, the same supplier outvoted a
  similar description.
- **What leaves:** a reversal removes the payable's example, and erasing the supplier
  removes all of theirs, after which nothing is suggested from them (e2e).
- **Once per event:** a redelivered `catalog.item.created` changes nothing (e2e).
- **The table** loads, is not loaded twice (e2e), and is retried after a failed start
  (unit).

## Measured, and said plainly

**The official table alone is a weak prior with `multilingual-e5-small`.** On twelve
common products, the right 4-digit heading was among the three candidates for 5
(coffee, cement, tyres, rice, milk), and not for 7:
- a stainless hex screw got stainless steel wire;
- an office chair got 7117 and 2504 instead of 9401;
- crystal sugar got 2203 and 2524, where 1702 sits beside 1701.

The measurement is in the smoke record, and it is not a gate. A hybrid with Portuguese
full text over the public table reached 6 of 12, too little for its cost, so it was not
built. This is why the table only answers when the workspace's own history has nothing,
and why every suggestion says where it came from.

## What changed from the plan

- **Two kinds, not three.** Statement lines have no category (ADR 0046), and no flow
  drafts a payable from XML (ADR 0051). Every payable is drafted in Financial's form, and
  the chip is there.
- **No model re-ranking.** `knowledge/` has no generation path. The assistant's is
  opt-in in `agent/` (Phase 76), and a second path for suggestions was not worth a second
  subprocessor.
- **An example distance per embedder** (0.1 for e5), tighter than the search's, and **the
  table as a fallback only.** Both were measured or seen in the browser during the phase,
  and are recorded in the plan.
- **No backfill.** The history starts with the events `knowledge/` receives from now on.

## Found along the way, not fixed

- **The Catalog items screen fails for a person without an Inventory role.** It reads
  `/inventory/warehouses`, which answers 403, and the whole screen reports it could not be
  loaded. This is older than Phase N. The browser check granted an Inventory role to go on.

## Verification

- `knowledge/`:
  - 63 unit tests (domain and application: 100% of lines, 92% of branches);
  - 25 e2e tests on pgvector, seven of them on suggestions.
- `web/`: 146 unit tests (3 new in `lib/suggestions.spec.ts`); typecheck and lint clean.
- **Smoke** `scripts/phase77-smoke.mjs`: 5 of 5 with `make up-ai`, and `--expect-off` 1 of
  1 with the default embedder.
- The phase's closing runs are listed in the commit's report.
