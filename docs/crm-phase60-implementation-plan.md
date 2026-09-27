# Phase 60 — CRM screens, golden path and release evidence

Status: **delivered on 2026-09-27** ([evidence](crm-phase60-evidence.md)). This is the execution record for
[Phase 60 of the CRM plan](crm-implementation-plan.md#60--crm-screens-golden-path-and-release-evidence).
Decisions: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## Result

After this phase a person works the CRM from the web, in pt-BR and in English, and
Phase L is closed with its release evidence:
- a **CRM** group in the navigation, visible to anyone holding a `crm` role (ADR 0045);
- the **pipeline** screen:
  - a board per pipeline with a column per stage;
  - a card moves by dragging it to another column, or from the keyboard with the arrow
    keys;
  - a table view of every opportunity, open, won or lost;
- an **opportunity** dialog:
  - facts, quotes and conversion, and a timeline of activities, tasks, notes and history;
  - actions: move, reassign, win, lose, reopen, record an activity, add a task, write a
    note;
  - **convert to quote**;
- **accounts**: the list, a new prospect registered in Parties, and each account's
  profile, contacts, opportunities and timeline;
- **my agenda**: the caller's open tasks, overdue ones first, completed from the screen;
- **forecast and metrics** at a chosen cutoff;
- **settings**: pipelines and their stages, sources and loss reasons.

The release evidence is:
- a CRM golden path on the local stack through Kong;
- a browser workflow in both languages;
- a restore check of CRM data;
- a CRM threat model and an API reference;
- the glossary and the events catalogue.

## Starting point

- The CRM API is complete (Phases 55–59). Every screen reads and writes through the web
  proxy `/api/horizon/crm`, already allowed since Phase 55.
- Existing patterns to reuse:
  - `Board`, `Resource` and `useLoader`;
  - the dialogs of Phase 53;
  - `PartyRegistrationForm` (Phase 54);
  - `QuoteFields` and `quoteBody` (Sales);
  - `useUrlParam` for deep links;
  - the lint rule that keeps copy out of components (ADR 0044).
- CRM keeps owners as user ids only. The web may show names from Identity's user list
  when the session may read it, and a short id otherwise.

## Decisions frozen by this plan

1. **The screens decide nothing.**
   - They offer what the session's CRM role allows: `write`, `assign` or `configure`.
   - Every command is still decided by CRM, Parties or Sales, and a refusal is shown with
     the reason the API gave.
2. **Keyboard moves on the board.**
   - A card is a focusable control. ArrowRight and ArrowLeft move it to the next or
     previous active stage.
   - A live region announces the move, and a hint under the board says how.
   - Dragging is the pointer equivalent. The table view and the dialog offer the same move
     through a select, so nothing depends on either.
3. **"Convert to quote" is the sequence of Phase 58, run by the screen:**
   1. if the account is not a customer, grant `customer` in Parties. A refusal (missing
      contacts, say) is shown with a link to the party;
   2. wait up to 30 seconds for Sales to list the customer, with a visible retry when it
      does not;
   3. write the quote with the lines the person chose and `opportunityId`, then link to it
      in the quotes screen (`?open=`).

   Nothing is sent to Sales before the customer exists there.
4. **The forecast and metrics screen shows the cutoff and whether it is settled.**
   Amounts are formatted per currency and never converted.
5. **Settings are for `configure`.** A pipeline stage is renamed, re-weighted, moved up or
   down, or archived; sources and loss reasons are renamed or archived. Nothing is deleted.
6. **The golden path runs through Kong only** (`scripts/crm-golden-path.mjs`):
   - a foreign prospect and a prospect without a document;
   - a contact at each;
   - an opportunity moved through its stages;
   - a task whose reminder fires once;
   - conversion to a quote, renegotiated and accepted;
   - the opportunity won with the source and owner checked at every step;
   - a metrics rebuild that leaves the numbers unchanged.

   It runs twice, to prove it is repeatable.
7. **The browser workflow logs in as the fiscal operator**, who is granted `crm:admin`
   through Identity. It works the same flow from the screens in pt-BR, then reads every
   CRM screen in English.

## Work

### A — Web

1. `lib/navigation.ts`: the CRM group (pipeline, accounts, agenda, forecast and metrics,
   settings) and its routes under `/app/crm/`.
2. `features/crm/`:
   - the data layer: API types, loaders and the command helper;
   - pipeline board and table;
   - opportunity dialog with timeline and actions, and the conversion dialog;
   - accounts view and account dialog;
   - agenda;
   - forecast and metrics;
   - settings.
3. Messages in `en.json` and `pt-BR.json`, and styles.
4. Unit tests for the pure helpers: the board's keyboard moves, stage order, timeline
   labels, owner names and the conversion steps.
5. `scripts/crm-workflow.e2e.mjs` (`npm run test:browser:crm`).

### B — Release evidence

1. `scripts/crm-golden-path.mjs`, run twice on the local stack.
2. `scripts/phase60-restore-check.sh`:
   - dump and restore `horizon_crm`;
   - digests of every CRM table for the tenant;
   - the guards still hold: the append-only history, the tolerance trigger, the note
     revisions and the destroyed keys;
   - another tenant sees nothing.
3. `docs/crm-threat-model.md`, `docs/crm-api.md`, the glossary and the events catalogue.
4. Close Phase L in `docs/plan.md`, `docs/erp-expansion-plan.md` and the CRM plan.

## Exit evidence

- `make check` and the local CI pass.
- The golden path and the browser workflow pass in pt-BR and en.
- Both expansion-plan exit criteria are proven:
  - the source and owner survive to an accepted quote;
  - the pipeline metrics are rebuilt from history.

## Revisions made while implementing

- **A cutoff chosen in the form was a whole minute.** The date-time field rounds down to
  the minute, so "Update" asked for a cutoff before facts recorded seconds earlier, and
  they vanished from the numbers. An empty cutoff now means "now on the server's clock",
  and only a cutoff the person chooses is sent. The browser workflow found it.
- **Selects whose default changed after mounting.** The forecast form and the account
  profile are remounted when what they show changes, so no select changes its default
  under Base UI.
- **The quotes screen opens a quote from `?open=`,** which the conversion links to.
- **The browser workflow meets the duplicate warning** of the registry (Phase 54) when a
  prospect looks like one already registered, and confirms it as a person would.

## Out of scope

- A CRM step in the CI golden-path workflow. It runs on the local stack, like the Phase 53
  service workflow.
- Webhook delivery of CRM events. The webhooks consumer refuses events of a tenant it did
  not provision (found in Phase 57); that is its own fix.
