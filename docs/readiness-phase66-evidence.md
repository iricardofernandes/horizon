# Phase 66 — evidence: search, command palette, saved views, notifications and the job centre

Status: **delivered on 2026-09-28** (local runs between 14:40 and 15:20 UTC).
Plan: [readiness-phase66-implementation-plan.md](readiness-phase66-implementation-plan.md).
API: [reporting-api.md](reporting-api.md#notifications-phase-66).

## What was delivered

- **Contracts 0.49.0,** with every consumer pinned. Seven event contracts are new:
  - `financial.payable.approval-requested`;
  - `parties|catalog|inventory|financial.import.finished`;
  - `sales.billing-run.finished`.

  `files.attachment.quarantined` gains an optional `uploadedBy`. None of them carries a
  name.
- **Producers.**
  - Financial publishes the approval request.
  - The import engine, identical in four modules, publishes `<module>.import.finished` in
    the transaction that finishes or cancels a job, abandoned jobs included.
  - Sales publishes the end of a billing run, once, when the run closes.
  - Files names the uploader of a quarantined file.
- **Search in the modules.**
  - `GET /catalog/items?search=` filters on SKU and name, case-insensitive, with `%` and
    `_` escaped.
  - `GET /parties/parties?search=` filters in memory: the 500 most recent decrypted
    parties, on names and email, ignoring accents, or on document digits. It never
    matches an erased party, and needs no index of personal data.
- **Reporting.**
  - **Notifications.** A `reporting.notifications` queue, and the `notifications` and
    `notification_reads` tables:
    - `notifications` is append-only and unique on the source event, kind and recipient;
    - Reporting notifies about its own exports and about reconciliations with
      differences;
    - the routes need a token only.
  - **Saved views.** The `saved_views` table, private or shared, changed by the owner only.
- **The web.**
  - **Federated search** (`/api/search`) and the **job centre** (`/api/jobs`,
    `/app/jobs`). They ask only what the roles read, with 1.5 s per module, and name what
    did not answer.
  - **The command palette** (Ctrl/⌘ K): screens, role-gated actions and results.
  - **The bell**, polled every 30 s.
  - **The views menu** on receivables, payables and CRM accounts, and a column picker on
    the titles lists.
  - All of it is in pt-BR and English.

## Exit criteria

| Criterion | Evidence |
|---|---|
| Search shows nothing the user's roles could not read, and one module being down does not break it | **Smoke:** an admin finds the party, item, CRM account and payable. A `catalog:viewer` asks only Catalog, and gets only the item. With `horizon-crm` stopped, the search answers Parties, Catalog and Financial, and reports `crm: timeout`. **Unit:** only readable sources are asked; a hanging source is a `timeout`; a `503` is an `error` and a `403` is `forbidden`; the rest still answer |
| A notification is created once per event, even on replay | **Smoke:** the `parties.import.finished` outbox row is set undispatched. The relay publishes the same event again, and there is still exactly one notification for it. **e2e:** the same envelope delivered three times gives `notified`, `duplicate`, `duplicate` and one row, and rewriting a notification is refused (`append-only`). **Unit:** the same, over the intake |
| The palette and the bell work from the keyboard alone | **Chromium, as the demo operator, keyboard only.** **The palette:** <ul><li>Ctrl+K opens it with the combobox focused;</li><li>typing `pay` lists "Payables" (screen) and "Record a payable" (action);</li><li>↓ and ↑ move `aria-selected`, and `aria-activedescendant` follows;</li><li>Enter opens `/app/finance/payables`;</li><li>typing `Coffee` lists parties, the item, the CRM account and titles;</li><li>Esc closes it and gives focus back to its button.</li></ul> **The bell:** <ul><li>Tab from the palette button reaches "Notifications, 1 unread";</li><li>Enter opens the list, and Tab reaches the item;</li><li>Enter opens `/app/crm/agenda` and marks it read, and the label returns to "Notifications";</li><li>Esc closes it with focus back on the bell.</li></ul> |

## Smoke (`node scripts/phase66-smoke.mjs`)

It runs in a fresh workspace each time.

| Step | Result |
|---|---|
| Search across modules | `catalog.items`, `crm.accounts`, `financial.payables`, `parties.parties` found; the catalog-only user sees 1 result, from Catalog |
| Search with CRM stopped | `crm: timeout`; Catalog, Financial and Parties still answered |
| Notifications for their people | **The admin:** `import-finished` for the Parties and the two Catalog imports, `billing-run-finished` and `file-quarantined`, but not the approval of their own payable. **The other financial admin:** `approval-payable`. **The catalog viewer:** nothing |
| A republished event | still 1 notification |
| Read per person | 5 unread, then 4 after one, then 0 after "read all"; the approver's own stays unread |
| A shared view | seen by another user as not theirs; their delete is `403`; the same name again is `409`; a user without a Reporting role reads views (`200`) |
| The job centre | `catalog.imports`, `parties.imports`, `sales.billing-runs`; only the user's own imports; `/app/jobs` answers `200` |

## Tests

| Project | Unit tests | New in Phase 66 |
|---|---|---|
| contracts | 139 | the new events, and the optional `uploadedBy` |
| reporting | 71, with domain and application at 97.8% of statements | the event-to-notification map, approvers but never the requester, once per event, per-person read state, dead-lettering; views ownership, duplicates and validation |
| web | 99 | federation (roles, budgets, statuses, own jobs, claims), palette (actions by role, screens, matching, keys), saved views (query, columns), notification messages |
| catalog | 92 | item search |
| parties | 74 | party search (accents, email, document digits, erased) |
| financial | 75 | the approval request event |
| sales | 124 | unchanged (the billing-run event is covered by the smoke) |
| files | 53 | unchanged |

**e2e:**
- Reporting: 18 tests, including the new ones for notifications once, role visibility and
  reads, and views per tenant.
- Parties imports: 9 tests. The finished event is asserted for a completed and a
  cancelled job.

## Findings along the way

- **A role notification must leave out the requester.** Otherwise a payable's requester
  who is also a financial admin is asked to approve their own payable. The smoke shows
  the requester is not notified, and another admin is.
- **Catalog refuses writes for a workspace it was never told about.** The smoke creates
  its item through Catalog's import, which provisions the tenant, as the Phase 64 smoke
  did.
- **A saved view needs filters to save.** Only the titles and CRM accounts lists keep
  filters today, so views are offered there (see the plan's revisions).
- **The demo operator's current token carries no Reporting role.** Its export request was
  refused (`403`), so the keyboard check of the bell used a real `crm.task.due` event
  published to RabbitMQ for that user.

## Verification

- `make check`: passed.
- Local CI (`make ci-local`): every step passed except Financial's e2e.
  - A payables test expected one outbox row, and there are now two: the approval request,
    then the post.
  - The test now checks both against their contracts, and Financial's e2e passes (43).
- Reporting e2e (18) and Parties imports e2e (9) against Testcontainers: passed.
- The smoke passed against the rebuilt stack: Parties, Catalog, Inventory, Financial,
  Sales, Files, Reporting and web.
