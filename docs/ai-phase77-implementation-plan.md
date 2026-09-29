# Phase 77 — Suggestions confirmed by a person

Status: **delivered on 2026-09-29** ([evidence](ai-phase77-evidence.md)). This is the execution record for
[Phase 77 of the AI with isolation plan](ai-implementation-plan.md#77--suggestions-confirmed-by-a-person),
built on ADR 0067 (one partition per tenant), ADR 0068 (derived data follows its source)
and ADR 0069 (models are ports, and nothing depends on them).

## Result

After this phase:
- **Creating a Catalog item suggests its NCM** from its name. The candidates come from:
  - the workspace's own items that already carry an NCM;
  - the official NCM table, embedded once for every workspace as public data.
- **Drafting a payable suggests its financial category** from the supplier and the
  description. The candidates come from the workspace's own posted payables, and the same
  supplier's count most.
- **Each suggestion shows its reason:** the neighbours it came from, or the official code's
  description.
- **A suggestion never writes.**
  - Accepting it fills the field, and the person saves with the module's own form and
    command.
  - Rejecting it records only the decision, as a metric.
- **Suggestions need the local model.** Without the stack's `ai` profile, the screens work
  and show none.

## Starting point

- **`knowledge/` (Phases 74 and 75):**
  - embedders behind a port: `hash-384-v1` by default, and `e5-small-v1` with `make up-ai`;
  - pgvector, one partition per tenant created by a security-definer function;
  - an inbox;
  - the `knowledge` service client, a viewer of Financial among others.
- **Events:**
  - `catalog.item.created` carries the name and the NCM;
  - `catalog.item.classification-changed` carries the new NCM;
  - `financial.payable.posted` carries the party, the category and the document number,
    but not the description. The payable's detail has the description and the supplier's
    name;
  - `parties.party.erased` ends a party.
- **What does not exist:**
  - **no flow drafts a payable from inbound XML.** ADR 0051 leaves payables to Financial,
    and every payable is drafted in its form (or by the agent's `draft_payable`);
  - **statement lines have no category.** ADR 0046 matches them to entries; it never
    classifies them.
- **The official table:** the Siscomex public download holds the full NCM nomenclature,
  about 15,000 codes and headings ("in force on 29/09/2026", Resolução Gecex nº 926/2026).

## Decisions frozen by this plan

1. **Two kinds of suggestion, not three** (a revision of the Phase N plan).
   - `ncm`, in Catalog's new-item form;
   - `payable-category`, in Financial's new-payable form.
   - The payable form is where any payable is drafted, including one from a supplier's
     XML, so "a payable drafted from inbound XML" is served there.
   - **The statement line is left out:** giving lines a category would be a new Treasury
     concept, not a suggestion.
2. **Suggestions live in `knowledge/`,** beside the embedder and the partitions.
   - **Routes:**
     - `GET /knowledge/suggestions/ncm?text=`;
     - `GET /knowledge/suggestions/payable-category?text=&partyId=`;
     - `POST /knowledge/suggestions/decisions`.
   - **Roles:** the first needs a Catalog role; the second a Financial read role. Both
     answer only from the caller's tenant.
3. **The confirmed history** is indexed from events into `examples PARTITION BY LIST
   (tenant_id)`: one partition per tenant, created by `ensure_example_partition` (security
   definer), with its own HNSW index and forced RLS.
   - **Items:** an item created with an NCM, or a classification set later, is an example.
     - Its text is the item's name, and its label is the NCM.
     - A classification set to none removes the example.
   - **Payables:** a posted payable is an example.
     - Its text is the supplier's name and the description, read through Kong as the
       `knowledge` service client; its label is the category, and it keeps the party.
     - A reversal removes it.
   - **Erasure:** `parties.party.erased` removes every payable example of that party. The
     vector was derived from its name (ADR 0068).
   - **What is stored:** the embedding, the label, the source id and a short reference, for
     the reason (an item's name and SKU; a payable's document number). There is no other
     text.
   - **No backfill:** the history starts with the events `knowledge/` receives from now
     on.
4. **The official NCM table** is public data, shared by all tenants.
   - `scripts/build-ncm-table.mjs` turns the Siscomex JSON into
     `knowledge/data/ncm-table.json.gz`:
     - each 8-digit code, with the descriptions of its chapter, heading and subheadings,
       so "- Outros" still means something;
     - and the table's act.
   - The worker loads it into `ncm_codes` (with its HNSW index) when the table or the index
     version changes, embedding it in the background.
5. **Ranking:**
   - the 10 nearest examples within the embedder's **example distance** each vote for their
     label, weighted by similarity (+0.5 for the same supplier). The example distance is
     0.1 for e5 and 0.6 for the hash embedder: measured, the same product named twice sits
     at about 0.06 with e5, and an unrelated one at about 0.16;
   - for `ncm`, the 5 nearest official codes vote at half weight, within the wider search
     distance. **When any example votes, the table's candidates are left out:** the table
     is the fallback, not a rival. The browser check showed wheat gluten and wine lees
     offered beside the workspace's own coffee NCM;
   - the three best labels are answered, each with up to three neighbours as its reason,
     or with the official description.

   Both rules are revisions made during the phase.
6. **Availability:** `KNOWLEDGE_SUGGESTIONS` is `auto` (on only with the `e5` embedder),
   `on` or `off`.
   - Off, a suggestion route answers `{ available: false, suggestions: [] }`, and the form
     shows nothing.
   - CI's tests turn it `on` with the hash embedder.
7. **No model re-ranking in this phase** (a revision of the Phase N plan).
   - Generation is the agent's, and opt-in per workspace (Phase 76).
   - Letting `knowledge/` send a workspace's history to a provider would be a second
     subprocessor path, for a gain the neighbours do not need.
   - It is deferred until a measured need.
8. **Decisions:**
   - `POST decisions { kind, decision: accepted | rejected, rank }` adds 1 to
     `knowledge_suggestion_decisions_total{kind,decision}`;
   - nothing is stored, and there is no tenant label, so acceptance rates are measurable
     and there is no training set.
9. **Web:**
   - a suggestion chip under the NCM field and under the category select, with its reason;
   - accepting it sets the field, and rejecting it hides the chip;
   - both post the decision;
   - pt-BR and en.

## Work

1. `scripts/build-ncm-table.mjs` and `knowledge/data/ncm-table.json.gz`.
2. **`knowledge/`:**
   - migration `0002_suggestions`: `examples` and its partition function, `ncm_codes`,
     the table's state;
   - the example handlers (items, payables, reversal, erasure) and the payable source;
   - the NCM loader;
   - the `Suggestions` use case, and its controller and metrics.
3. **Web:** `lib/suggestions.ts`, the chip, and the two forms.
4. **Tests:**
   - units: ranking, the table builder's parsing, the use case, the handlers;
   - e2e on pgvector:
     - examples in one partition per tenant, and the plan;
     - the canary: another tenant's item never votes;
     - reversal and erasure;
     - the loader;
     - off answers nothing.
5. **`scripts/phase77-smoke.mjs`** through Kong:
   - with the hash embedder: `available: false`;
   - with `make up-ai`:
     - an item named like an earlier one gets its NCM, with the neighbour as reason;
     - an item with a new name gets the official table's code;
     - a second workspace's item never appears;
     - a payable for a known supplier gets its category;
     - an item created with an accepted suggestion leaves the same audit entry as one typed.

## Exit evidence

- Accepting a suggestion produces the same record and audit entry as typing it.
- A tenant's history never feeds another tenant's suggestions.
- With the `ai` profile off, the screens work and show no suggestion.
