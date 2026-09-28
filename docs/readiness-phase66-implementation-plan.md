# Phase 66 — Search, command palette, saved views, notifications and the job centre

Status: **delivered on 2026-09-28** ([evidence](readiness-phase66-evidence.md)). This is the execution record for
[Phase 66 of the production readiness plan](production-readiness-implementation-plan.md#66--search-command-palette-saved-views-notifications-and-the-job-centre).
Decisions: ADR 0058 §4 (user state lives in `reporting/`), ADR 0047, ADR 0060.

## Result

After this phase, a person can:
- **Find anything** from one box. The web server asks each module they can read, and says
  which one did not answer.
- **Press Ctrl/⌘ K** anywhere for the command palette:
  - the screens they can open;
  - the actions their roles allow;
  - search results.
- **Keep a list's filters as a view,** for themselves or shared with the workspace, and
  come back to it with one click.
- **See a bell** with what needs them:
  - a CRM reminder;
  - an approval;
  - a finished import, export or billing run;
  - a quarantined file;
  - a reconciliation that did not match.
- **Open the job centre:** one screen with their imports, exports, billing runs and
  supplier NF-e imports, across modules.

## Starting point

- **Search.**
  - CRM accounts (`?search=`) and Financial titles (`?search=`) already filter by text.
  - Catalog items and Parties do not.
  - A party's names are encrypted, so Parties cannot filter them in SQL.
- **Events for notifications:**
  - `crm.task.due` names the assignee;
  - `procurement.requisition.submitted` and `procurement.order.placed`
    (`approvalRequired`) mean an approval is waiting;
  - `files.attachment.quarantined` names no one;
  - a payable waiting for approval, a finished import and a finished billing run publish
    nothing today.
- **Reporting** already:
  - consumes events;
  - has an audit chain and saved report filters;
  - runs exports and reconciliations, whose results it can notify about directly.
- **Jobs:**
  - each importing module lists its jobs (`GET /imports`, admin);
  - Reporting lists exports;
  - Sales lists billing runs;
  - Fiscal lists supplier NF-e imports.

  CRM's `rebuild:metrics` is a command-line job with no API.
- **The web** has a session with the user's roles, a navigation table filtered by module,
  and a proxy to every module.

## Decisions frozen by this plan

1. **Contracts 0.49.0 add the events a notification needs.** Each is additive:
   - **`financial.payable.approval-requested`** `{ titleId, requestedBy, amount }`,
     published when a payable draft asks for approval.
   - **`parties|catalog|inventory|financial.import.finished`**
     `{ jobId, kind, status, requestedBy, total, written, failed, cancelled }`. The import
     engine publishes it in the transaction that finishes the job.
   - **`sales.billing-run.finished`**
     `{ runId, competence, startedBy, billed, skipped, failed }`, published when a run ends.
   - **`files.attachment.quarantined`** gains an optional `uploadedBy`.

   None of them carries a name, a document or an amount beyond what the existing events
   already carry.
2. **Federated search (`GET /api/search?q=` in the web server).**
   - It asks only the modules the session's roles can read, in parallel, with a budget of
     1.5 seconds each:

     | Module | Endpoint | Reads |
     |---|---|---|
     | Parties | `GET /parties/parties?search=` | legal and trade name, email |
     | Catalog | `GET /catalog/items?search=` | SKU and name |
     | CRM | `GET /crm/accounts?search=` | account names |
     | Financial | `GET /financial/receivables?search=`, `/payables?search=` | document and description |

   - The answer is the results, and each module's status: `ok`, `timeout`, `error` or
     `forbidden`. One module down never fails the whole search.
   - The token goes with every call, so a module refuses what its roles do not allow even
     if the web asked by mistake.
   - Nothing is indexed centrally.
   - **Parties** filters its decrypted page in memory: the 500 most recent parties, for a
     term of at least 2 characters. It needs no index of personal data.
   - **Catalog** filters in SQL, on SKU and name, case-insensitive.
3. **The command palette.** Ctrl/⌘ K, or the header button, opens a dialog with one input.
   - It lists three groups: screens, actions and results.
     - **Screens:** the navigation entries the roles allow.
     - **Actions:** a few verbs per module, each gated by the module role. Examples are new
       party, new order and new import.
     - **Results:** from the federated search, after 250 ms of quiet.
   - It is an ARIA combobox with a listbox. Arrows move, Enter opens, and Esc closes and
     returns focus.
4. **Saved views (in `reporting/`).**
   - A view is `{ screen, name, query, columns }`:
     - `query` is the list's URL query string (filters and sort), up to 1,000 characters;
     - `columns` is the visible columns, where the screen lets a person choose them.
   - A view is private or shared with the workspace by its owner. Only the owner changes
     or deletes it.
   - **Routes** (`GET`/`POST`/`PATCH`/`DELETE /views`) need only a token, not a Reporting
     role: a view holds no data, only a way to look at data the module still authorizes.
   - **The web:** a views menu on the Financial titles, Catalog items, CRM accounts and
     Procurement orders lists. The titles list also lets a person choose its columns.
5. **Notifications (in `reporting/`).**
   - **Delivery.** A queue, `reporting.notifications`, bound to the events of §1 plus
     `crm.task.due`, `procurement.requisition.submitted` and `procurement.order.placed`.
   - **Once per event.** A notification is unique on `(tenant, source event, recipient)`.
     A redelivery or a republished event inserts nothing. Replays of history
     (`reporting.replay`) never notify.
   - **Recipients:**
     - **a user:** the assignee, the requester, the uploader or whoever started the run;
     - **a role:** for an approval, the module roles that can approve it, checked against
       the reader's token.

     Approvals delegated to someone else wait for Phase 68.
   - **Reporting's own results** notify their person directly: an export that finished or
     failed, and a reconciliation run that did not match.
   - **Content.** A notification holds its kind, parameters without personal data (ids,
     counts, statuses), and a link to the record. The web renders the text in the
     reader's language.
   - **Routes** (a token is enough):
     - `GET /notifications` (the latest 50);
     - `GET /notifications/unread-count`;
     - `POST /notifications/{id}/read`;
     - `POST /notifications/read-all`.

     Read state is per user, even for a role notification.
   - **The bell** sits in the header with the unread count. It opens a list, polled every
     30 seconds. Each item links to its record and is marked read when opened. It works
     from the keyboard.
6. **The job centre (`GET /api/jobs` and `/app/jobs`).**
   - The web server gathers the user's jobs, each source within the same budget:
     - Parties, Catalog, Inventory and Financial imports, filtered to the ones they
       uploaded;
     - Reporting exports;
     - Sales billing runs;
     - Fiscal supplier NF-e imports.
   - Each job shows its module, kind, status, progress and when it ran, with a link.
   - Each source that did not answer is named.
   - CRM's `rebuild:metrics` has no API and stays a command-line job.

## Work

### A — Contracts 0.49.0
The new events and the optional `uploadedBy`, with tests. Then repin every consumer.

### B — Producers
1. Financial: the approval request publishes its event.
2. The import engine: finishing publishes `<module>.import.finished`, in all four copies.
3. Sales: a finished billing run publishes its event.
4. Files: the quarantine event names the uploader.

### C — Search in the modules
1. Catalog: `GET /items?search=`.
2. Parties: `GET /parties?search=`.

### D — Reporting
1. **Migration:**
   - `saved_views`;
   - `notifications`, unique on the source event and recipient;
   - `notification_reads`.
2. **The notifications consumer and its use cases,** plus the notifications from exports
   and reconciliations.
3. **The routes** for views and notifications, which need a token only.

### E — Web
1. The search route and the jobs route, both with per-module budgets.
2. The palette, the bell, the views menu and the job centre page, in pt-BR and English.

### F — Evidence
1. Unit and e2e tests: search budgets, notifications once, and views ownership.
2. `scripts/phase66-smoke.mjs`:
   - search with one module stopped;
   - a notification for each source, once;
   - a view shared;
   - the job centre.
3. The palette and the bell driven from the keyboard, in Chromium.

## Exit evidence

- Search shows nothing the user's roles could not read, and one module being down does not
  break it.
- A notification is created once per event, even on replay.
- The palette and the bell work from the keyboard alone.

## Revisions made while implementing

- **Saved views on two lists, not four.**
  - The Catalog items and Procurement orders screens have no filters to keep yet.
  - Views are on the Financial titles lists (tab, search and columns) and the CRM
    accounts list (search and role).
  - The API takes any `<module>.<list>` screen, so another list needs no new route.
- **Approvals.**
  - A role notification leaves out the person who asked, so nobody is asked to approve
    their own request.
  - Delegated approvers wait for Phase 68.
- **Proving "once, even on replay".** The smoke republishes a real outbox row by clearing
  its `dispatched_at`. The relay sends the same event again, and no second notification
  appears.
- **New import events are journaled too.** Reporting's journal binds to every event of
  the journaled modules. The new Catalog, Inventory, Financial and Sales events are kept
  there as well, and the producers' seals count them from their outbox, so the seals
  still match.

