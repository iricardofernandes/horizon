# CRM implementation plan — Phase L

Status: **in progress** — Phases 54 to 56 delivered on 2026-09-27. This is the execution plan for Phase L of the
[ERP expansion plan](erp-expansion-plan.md#phase-l--crm), split into phases 54–60 of
[plan.md](plan.md). Each numbered phase gets its own detailed plan before implementation,
one local commit and an evidence record, as in Phases J and K.

## Outcome and boundaries

Horizon sells to customers it already knows. Phase L lets it **win** them:
- accounts and the people who work there;
- opportunities that move through configurable pipelines, owned by a person, attributed
  to a source and closed as won or lost with a reason;
- the tasks, notes and activities around them, with reminders;
- a forecast of what the pipeline is expected to convert;
- the hand-off to a Sales quote that keeps the source and the owner through acceptance.

Anyone the business talks to can be an account. That includes a foreign company, or a
person who has not given a CPF yet. A missing Brazilian document never blocks the CRM.

Out of scope:
- marketing automation, campaigns, email sequences and lead scoring;
- mailbox, calendar or telephony integration: activities are recorded, not captured;
- web forms and public lead capture endpoints;
- per-owner record visibility: roles stay module-scoped (ADR 0023), so a CRM user sees the
  whole tenant's pipeline;
- NF-e for a foreign recipient (export): Fiscal refuses it with a visible code until a
  later phase supports `idEstrangeiro`;
- cross-domain dashboards (Phase M).

## What already exists

| Need | Where it is today |
|---|---|
| Organizations and people | `parties/`: one party, many roles, including `prospect` and `partner` (ADR 0040) |
| Role changes as facts | `parties.party.role-granted` and `role-revoked`, consumed by Sales, Procurement and Financial |
| Erasure | Crypto-shredding: `parties.party.erased` and `identity.data-subject.erased` (docs/privacy.md) |
| Users who can own records | Identity users, published by `identity.user.registered` and `identity.user.disabled` |
| Quotes | Sales versioned quotes with a seller, published as `sales.quote.sent`, `accepted` and `rejected` |
| Customers in Sales | A projection of parties that hold the `customer` role |
| Module name and port | `crm`, port 3012, reserved by the expansion plan |

Gaps:
- **A party needs a CPF or a CNPJ, an email, a phone and an address.** A foreign company,
  a person without a CPF, or a prospect known only by name cannot be registered. The
  published `parties.party.registered` v1 makes email, phone and address required.
- No module owns contacts (people at an account), opportunities or activities.
- A quote does not know which opportunity it came from, so attribution is lost at the
  hand-off.

## Decisions to take first (Phase 54)

1. **Party identification beyond CPF and CNPJ** (ADR 0057, revising ADR 0040).
   - A party's document is typed:
     - `cpf`;
     - `cnpj`;
     - `foreign`, with the country (ISO 3166-1) and a free identifier;
     - `none`.
   - Uniqueness applies only to a document that is present, per type and country.
   - A prospect needs only a name. Email, phone and address become optional in the
     registry.
   - Each role states what it needs:
     - `customer` needs one way to reach the party and an address;
     - `supplier` keeps what Procurement and Financial need today.
   - A document is not required for any role. Fiscal decides per document whether it can
     issue to that recipient, and says why when it cannot.
   - Party events get a v2 with the typed document kind (never the number) and nullable
     contact fields. Consumers accept v1 and v2 until every producer publishes v2.
2. **Boundary.** CRM is its own module, `crm/` on port 3012.
   - Unlike services (ADR 0056), it shares no price list, stock or document numbering with
     Sales. Its aggregates have their own lifecycle and history.
   - It follows the platform wiring of the expansion plan in its first commit.
3. **An account is a party.**
   - CRM projects parties holding `prospect`, `customer` or `partner`. The account id is the
     party id.
   - CRM never registers organizations itself: the screen creates the party in Parties
     with the `prospect` role, and CRM picks it up from the event.
   - Before creating a party without a document, the screen warns about possible
     duplicates by name, email and phone.
4. **Contacts belong to CRM.**
   - A contact is a person at an account: name, job title, email, phone, and the lawful
     basis for holding the data.
   - Contacts are not parties. They play no commercial role and need no document.
   - Their personal fields are encrypted under the contact's own key. Erasing the contact,
     or its account's party, shreds them.
5. **Ownership and the hand-off to Sales.**
   - CRM owns accounts, contacts, pipelines, opportunities and activities. Sales owns the
     quote. Parties owns roles.
   - CRM never calls or writes Sales. Sales projects open opportunities from `crm.*`
     events.
   - A quote may name an opportunity. Sales copies its source and owner from its own
     projection, never from the request, and freezes them on the quote.
   - Converting a prospect's opportunity grants the `customer` role through Parties first.
     The screen waits for the Sales projection before opening the quote.
   - CRM follows `sales.quote.*` to link the quote, and closes the opportunity as won when
     a quote is accepted.
6. **History is the source of truth for metrics.**
   - Every stage change, owner change, win, loss and reopening is an append-only
     opportunity event, with actor, instant and reason.
   - Forecast and conversion metrics are projections that can be dropped and rebuilt from
     that history. A rebuild must equal the live read.

## Phases

### 54 — Parties without a Brazilian document, and CRM decisions

[Detailed Phase 54 plan](crm-phase54-implementation-plan.md) ·
[evidence](crm-phase54-evidence.md).

**Work**
1. ADR 0057 records the decisions above.
2. Parties accepts the typed document and optional contact fields:
   - migration and backfill of existing parties to `cpf` or `cnpj`;
   - uniqueness only on documents that are present;
   - per-role completeness checks.
3. Party events v2 are added to `@horizon/contracts`.
   - Sales, Procurement and Financial accept both versions.
   - Their projections handle a party without email, phone or address.
4. Parties refuses a fiscal profile to a party without a CPF or a CNPJ. Fiscal then has no
   recipient projection for it and refuses an NF-e with its existing visible code
   (`DOCUMENT_NOT_READY`); NFC-e behaviour is unchanged.
5. The party screens offer the document type, the country and a duplicate warning.

**Exit evidence**
- A foreign company and a person without a CPF are registered, become customers, and
  receive a quote.
- Existing parties keep their ids and documents.
- A replayed v1 event and a v2 event give the same projection.
- The goods golden path is unchanged.

### 55 — The CRM module, accounts and contacts

[Detailed Phase 55 plan](crm-phase55-implementation-plan.md) ·
[evidence](crm-phase55-evidence.md).

**Work**
1. `crm/` exists with the full platform wiring:
   - `modules.json`, Makefile, compose, Kong, database, contracts, proxy allowlist, CI
     lists and demo;
   - the `crm` module and its roles `admin`, `manager`, `representative` and `viewer`;
   - every service moved to the contracts version that declares the module, before anyone
     is granted a role.
2. The account projection is fed by party events, with erasure. Account-only fields live
   in CRM: owner, segment, tags and the source it came from.
3. Contacts: create, edit, deactivate and erase. Personal fields are encrypted per
   contact. The account shows its contacts.
4. An owner projection is fed by identity users. A disabled user keeps their records but
   receives no new ones.

**Exit evidence**
- Cross-tenant and RLS tests cover every table.
- Erasing a party shreds its account's contacts. Erasing a contact leaves its account.
- The smoke registers a prospect in Parties and finds it as a CRM account.

### 56 — Pipelines and opportunities

[Detailed Phase 56 plan](crm-phase56-implementation-plan.md) ·
[evidence](crm-phase56-evidence.md).

**Work**
1. Configurable pipelines:
   - ordered stages, each with a win probability in basis points;
   - one `won` and one `lost` terminal state;
   - a stage in use is archived, never deleted.
2. Sources and loss reasons are tenant lists, archived rather than deleted.
3. An opportunity has:
   - an account, optional contacts, an owner and a source;
   - an expected value (`Money`), an expected close date, a pipeline and a stage.

   It is moved, reassigned, won, lost with a reason, or reopened.
4. Each change appends an opportunity event and publishes `crm.opportunity.*`: `created`,
   `stage-changed`, `owner-changed`, `won`, `lost` and `reopened`.

**Exit evidence**
- Archiving a stage leaves the opportunities on it and their history intact.
- A lost opportunity keeps its reason; reopening it keeps both closures in its history.
- Replaying CRM events gives the same opportunity state.

### 57 — Activities, tasks, notes and reminders

**Work**
1. Activities (call, meeting, email, visit) record what happened, when and with whom.
   They attach to an account, a contact or an opportunity.
2. Tasks have an assignee, a due instant and an optional reminder. They are completed or
   cancelled, never deleted.
3. Notes are append-only revisions. A person can correct a note, and the earlier text
   stays in its history.
4. Reminders:
   - a scheduler marks reminders as due, once each, across restarts;
   - "my agenda" lists due and overdue tasks;
   - `crm.task.due` is published for webhooks.
5. A timeline read merges activities, tasks, notes and opportunity events for an account
   or an opportunity.

**Exit evidence**
- A reminder fires once, even when the scheduler restarts or runs twice.
- The timeline is ordered and tenant-scoped.
- Correcting a note keeps the earlier text.

### 58 — Conversion to quote and attribution

**Work**
1. Sales projects open opportunities from `crm.opportunity.*`.
2. A quote may carry an `opportunityId`:
   - Sales freezes the opportunity's source and owner on the quote;
   - new versions of the quote inherit them;
   - `sales.quote.*` gains the attribution as an additive, versioned change.
3. "Convert to quote":
   - grants `customer` through Parties when the account is still a prospect;
   - waits for the Sales customer projection;
   - opens a new quote for the opportunity.
4. CRM consumes `sales.quote.sent`, `accepted` and `rejected`:
   - it links each quote to its opportunity;
   - an accepted quote closes the opportunity as won, with the quote id and value;
   - it publishes `crm.opportunity.converted` for reporting.
5. An opportunity closed by an accepted quote cannot be reopened by hand. Only a new
   opportunity can follow up on it.

**Exit evidence**
- Account → contact → opportunity → quote → accepted quote keeps the source and the owner
  on every step, including a renegotiated version.
- A replayed quote event does not close an opportunity twice.
- CRM writes nothing to Sales, and Sales takes no attribution from the request body.

### 59 — Forecast and pipeline metrics rebuilt from history

**Work**
1. Forecast by expected close month: open value, weighted value (value × stage
   probability) and won value, per pipeline, owner and source.
2. Conversion metrics:
   - stage-to-stage conversion;
   - time in stage;
   - win rate;
   - loss reasons.
3. The projections can be rebuilt from opportunity events. The rebuild runs as a bounded
   command, with progress and a comparison against the live tables.
4. A metric counts only closed and stage-change facts up to a declared cutoff instant, so
   a report can be reproduced later.

**Exit evidence**
- Dropping and rebuilding the metrics gives the same numbers as the live projection.
- A back-dated or replayed event cannot change a closed cutoff.

### 60 — CRM screens, golden path and release evidence

**Work**
1. Screens in pt-BR and en:
   - a pipeline Kanban (drag between stages, with keyboard support) and a table view;
   - accounts and contacts;
   - opportunity detail with its timeline;
   - my agenda;
   - forecast and pipeline metrics;
   - pipeline, source and loss-reason settings.

   The CRM group joins the navigation registry, visible by permission (ADR 0045).
2. Golden path on the local stack: a foreign prospect and a prospect without a document →
   contact → opportunity through stages → task and reminder → convert to quote →
   accepted → won, with the attribution checked. A metrics rebuild is compared as well.
3. Browser workflow, restore check of CRM data, threat model section (contact personal
   data), glossary, events catalogue and API docs.
4. Close Phase L in the plan and the expansion plan.

**Exit evidence**
- `make check` and the local CI pass.
- The golden path and the browser workflow pass in pt-BR and en.
- Both expansion-plan exit criteria are proven:
  - the source and owner survive to an accepted quote;
  - the pipeline metrics are rebuilt from history.

## Contracts added across the phase

Additive, versioned in `@horizon/contracts` and pinned by every consumer (ADR 0029, 0030):
- **Events:**
  - `parties.party.registered` and `parties.party.updated` v2 (typed document kind,
    nullable contact fields);
  - `crm.opportunity.created`, `revised`, `stage-changed`, `owner-changed`, `won`,
    `lost` and `reopened` (Phase 56), and `converted` (Phase 58);
  - `crm.task.due`;
  - `sales.quote.*` with optional attribution.
- **Module and roles:** `crm` with `admin`, `manager`, `representative` and `viewer`.
- **HTTP schemas** for accounts, contacts, pipelines, opportunities, activities, tasks,
  notes, forecast and metrics.

## Risks

- **Party v2 touches every consumer.** Sales, Procurement and Financial must accept both
  versions before Parties publishes v2. Phase 54 goes before any CRM code for this
  reason.
- **Duplicates without a document.** Without CPF/CNPJ uniqueness, the same company can be
  registered twice. The warning helps but does not guarantee anything. Merging parties is
  out of scope and would need its own ADR.
- **Foreign customers downstream.** Quotes and orders work, but the NF-e does not until
  export is supported. The screens must show the Fiscal refusal instead of hiding it.
- **Contact personal data.** Contacts are the first CRM personal data. Their encryption,
  retention and erasure must be in the threat model before Phase 60 closes.
- **Convert-to-quote waits on two projections** (Parties → Sales). The screen needs a
  bounded wait with a clear retry, not an optimistic quote that later fails.
