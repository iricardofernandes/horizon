# Phase 58 — Conversion to quote and attribution

Status: **delivered on 2026-09-27** ([evidence](crm-phase58-evidence.md)). This is the execution record for
[Phase 58 of the CRM plan](crm-implementation-plan.md#58--conversion-to-quote-and-attribution).
Decisions: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## Result

After this phase:
- **Sales projects open opportunities** from `crm.opportunity.*`: account, owner, source
  and status.
- **A quote may name an opportunity.** Sales checks the opportunity against its own
  projection and freezes its owner and source on the quote. Every later version inherits
  them.
- **`sales.quote.sent`, `accepted` and `rejected` carry the attribution** as an optional
  field. This is an additive change in contracts 0.45.0, so consumers that ignore the field
  keep working.
- **CRM follows the quotes of its opportunities.**
  - It links each quote to its opportunity.
  - An accepted quote converts the opportunity: it becomes won, at the quote's value, and
    records the quote. CRM publishes `crm.opportunity.converted`, and also
    `crm.opportunity.won` when the opportunity was not won already.
  - A converted opportunity cannot be reopened.
- **"Convert to quote"** is a sequence of calls through the gateway, and the phase 60 screen
  will run the same sequence:
  1. grant `customer` in Parties when the account is still a prospect;
  2. wait until Sales lists the customer;
  3. write the quote with the opportunity id.

  The smoke runs it end to end.

## Starting point

- Sales:
  - quotes are versioned: a new version supersedes a sent one and shares its `rootId`;
  - the terms carry an optional `sellerId`, taken from the request;
  - `sales.quote.*` v1 payloads are plain objects, so an added optional field is additive
    for their consumers;
  - Sales consumes only what it binds, one routing key per handler.
- CRM:
  - opportunities are event-sourced, and a won or lost opportunity can be reopened;
  - `crm.opportunity.*` v1 are strict objects;
  - CRM consumes nothing from Sales yet.
- Parties grants a role with `PUT /parties/{id}/roles/customer`. A customer needs one way
  to reach the party and an address (ADR 0057).

## Decisions frozen by this plan

1. **The attribution is Sales's own copy, frozen at the first version.**
   - `POST /quotes` accepts `opportunityId`, and nothing else about the opportunity. The
     request schema is strict, so a body carrying `ownerId`, `sourceId` or `attribution`
     is refused.
   - Sales reads the owner and the source from its projection when it writes the first
     version, then keeps them on every version of the offer. A later reassignment in CRM
     does not rewrite an offer already made. The quote records who owned the opportunity
     when the offer was made.
   - The opportunity must be known to Sales and open, and it must belong to the quote's
     customer: the account id is the party id, which is the customer id.
   - `sellerId` stays what it was: who is selling. It is not the attribution.
2. **The Sales projection is ordered by the fact's instant, field by field.**
   - Events may arrive out of order. The account, owner, source and status of a projected
     opportunity each keep the instant of the fact that last set them.
   - An older fact never overwrites a newer one.
3. **Conversion is one opportunity fact, `converted`.**
   - It records the quote (id, root, version and value).
   - It sets the status to won, the value to the quote's total, and the quote as the
     conversion.
   - An opportunity that was open or lost becomes won. A lost one keeps its earlier loss in
     the history. One already won by hand keeps its closing date.
   - `crm.opportunity.converted` v1 carries the opportunity, account, quote, value, owner,
     source and closing date. `crm.opportunity.won` is published as well when the status
     changed, so a Phase 59 consumer that reads only closures still sees the win.
   - An opportunity converts once. A second accepted quote for it is linked but does not
     convert it again, and a replayed `accepted` changes nothing.
4. **A converted opportunity cannot be reopened.** A follow-up is a new opportunity.
5. **CRM keeps the quotes of an opportunity.**
   - `opportunity_quotes` holds, per offer (`quoteRoot`), the latest version seen, its
     status (`sent`, `accepted` or `rejected`), its total and when it was seen.
   - An older version never overwrites a newer one.
   - The opportunity detail lists them.
6. **No module writes another's data.**
   - CRM has no Sales URL or credentials, and learns about quotes only from events.
   - Sales learns about opportunities only from events.
   - The conversion's role grant is a Parties command made by the caller, not by CRM.

## Work

### A — Contracts (0.45.0)

- `sales.quote.sent`, `accepted` and `rejected` v1 gain an optional, nullable
  `attribution: { opportunityId, ownerId, sourceId }`.
- `crm.opportunity.converted` v1 is added.
- Every module is pinned to 0.45.0.

### B — Sales

1. **Domain:**
   - `Quote` gains `attribution`, copied by `nextVersion` and included in its events;
   - an `OpportunityProjection` port.
2. **Application:**
   - `WriteQuoteUseCase` takes an optional `opportunityId` and resolves it against the
     projection;
   - `crm.opportunity.created`, `revised`, `owner-changed`, `won`, `lost`, `reopened` and
     `converted` are consumed into the projection.
3. **Migration `0016_opportunity_attribution`:**
   - `opportunity_projections`, with forced RLS and grants;
   - `quotes.opportunity_id`, `attributed_owner_id` and `attributed_source_id`, all null or
     all set.
4. **HTTP:** `opportunityId` on `POST /quotes`, and the attribution in the quote reads.

### C — CRM

1. **Domain:**
   - the `converted` fact, with `applyFact` and the publication of `won` and `converted`;
   - `reopen` refuses a converted opportunity.
2. **Application:** consuming `sales.quote.sent`, `accepted` and `rejected` into
   `opportunity_quotes` and the conversion.
3. **Migration `0003_quote_conversion`:**
   - `opportunities.converted_quote_id`;
   - `converted` in the history's type check;
   - `opportunity_quotes`, with forced RLS and grants.
4. **HTTP:** the opportunity detail shows its quotes and the conversion.

### D — Evidence

1. Unit tests:
   - the quote attribution (write, versions, events, refusals);
   - the Sales projection ordering;
   - the CRM conversion (open, lost, already won, second quote, replay);
   - reopening refused.
2. e2e:
   - Sales on PostgreSQL: projection, attribution frozen across versions, a strict body;
   - CRM on PostgreSQL: a replayed `accepted` converts once, a history that folds with
     `converted`, RLS on the new table.
3. `scripts/phase58-smoke.mjs` through Kong:
   - a prospect account, a contact and an opportunity with a source;
   - `customer` granted, and the Sales customer awaited;
   - a quote on the opportunity, sent, renegotiated after the opportunity is reassigned,
     then accepted;
   - the attribution checked on both versions and on the events;
   - the opportunity won by conversion, and reopening it refused.
4. `make check`, the Sales and CRM e2e, `make ci-local`, and isolated jobs.

## Exit evidence

- Account → contact → opportunity → quote → accepted quote keeps the source and the owner
  on every step, including a renegotiated version.
- A replayed quote event does not close an opportunity twice.
- CRM writes nothing to Sales, and Sales takes no attribution from the request body.

## Revisions made while implementing

- **The Sales projection accepts facts before the creation.** A `revised` or an
  `owner-changed` can arrive before `created`, and neither carries every field. The
  owner, source and status are therefore nullable, each with the instant of the fact
  that set it. A quote needs an opportunity whose owner and status are known and open.
- **The conversion carries CRM's owner at that moment.** `crm.opportunity.converted`
  names who owns the opportunity when it converts; the quote keeps who owned it when the
  offer was made. The smoke reassigns the opportunity between the two, and both are
  recorded.

## Out of scope

- Forecast and metrics (Phase 59).
- The screens and the conversion button (Phase 60).
- Converting an opportunity into a sales order directly: the order still comes from the
  accepted quote.
