# `crm/`

The accounts the business is trying to win or keep, the people it talks to there, and
who looks after each account.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/crm`, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 59 — accounts, contacts, owners, pipelines, opportunities, activities,
tasks, notes, reminders, the conversion to a Sales quote, and the forecast and pipeline
metrics.** The screens arrive in phase 60 ([CRM plan](../docs/crm-implementation-plan.md)).

---

## What this context owns

- **Accounts** — a projection of every party holding `prospect`, `customer` or `partner`
  (ADR 0057), keyed by the party id. The registry owns the name, document and roles; CRM
  owns the **owner**, the **segment** and the **tags**. An account that loses its CRM
  role stays, inactive; one whose party is erased keeps its row with the names blanked.
- **Contacts** — people at an account: name, job title, email, phone and the lawful
  basis for holding them. The personal fields are sealed under a key per contact;
  erasing the contact, or its account's party, destroys that key (ADR 0026).
- **Owners** — the workspace's users as ids and an active flag, fed by
  `identity.user.registered` and `identity.user.disabled`. No name or email is kept.
- **Pipelines** — ordered open stages with a win probability in basis points; stages and
  pipelines are archived, never deleted. Won and lost are outcomes, not stages.
- **Sources and loss reasons** — workspace lists, archived rather than deleted; an
  account and an opportunity carry a source.
- **Opportunities** — an account, contacts, owner, source, expected value and close date,
  pipeline and stage; moved, revised, reassigned, won, lost with a reason and reopened.
  The append-only history (`opportunity_events`) is the source of truth, and the record is
  its fold.
- **Activities, tasks and notes** — attached to an account, a contact or an opportunity,
  always stored with their account. An activity (call, meeting, email, visit) is corrected,
  not deleted; a task has an assignee, a due instant and an optional reminder, and is
  completed or cancelled; a note is corrected by appending a revision. Their free text is
  sealed under a key of the account, destroyed with its party; erasing the party also
  cancels its open tasks.
- **Quotes and conversion** — CRM follows the Sales quotes made for an opportunity from
  `sales.quote.*` and keeps the latest version of each offer. An accepted quote converts
  the opportunity once: won at the quote's total, with the quote recorded, even if it was
  lost or won by hand. A converted opportunity is never reopened. CRM never calls or writes
  Sales.
- **Forecast and pipeline metrics** — read as of a cutoff instant from projections that
  are a function of each opportunity's history (`metric_states`, `metric_stage_visits`,
  `metric_closures`), replaced with it in the same transaction. The history refuses a fact
  recorded more than two minutes from the database clock, so a cutoff older than ten
  minutes is *settled*: its numbers can be reproduced later.
- **Reminders** — a scheduler in this service sends each armed reminder once as
  `crm.task.due`, even across restarts or with several instances; rescheduling a task
  arms it again.
- **Audit** — every command appends to the tenant's hash chain (ADR 0025), with field
  names and never contact values.

## What it explicitly does not own

- Parties, their documents and contacts: `parties/` is authoritative, and CRM never
  registers an organization itself.
- Quotes and orders: Sales owns them; CRM will hand off to a quote in phase 58 without
  writing to Sales.

## Events

Consumed: `parties.party.registered` and `updated` (v1 and v2), `parties.party.erased`,
`identity.user.registered` and `identity.user.disabled`, and `sales.quote.sent`,
`accepted` and `rejected` when they carry an attribution. Published: `crm.opportunity.created`,
`revised`, `stage-changed`, `owner-changed`, `won`, `lost` and `reopened` (v1) — with the
stage probability, owner, source and value at that moment, never the title or contacts.
A revision that changed only the title or contacts is kept in the history, not published.
`crm.opportunity.converted` (v1) names the accepted quote, its total, the owner and the
source; `crm.opportunity.won` is sent with it when the opportunity was not won already.
`crm.task.due` (v1) names the task, its account and subject, the assignee and the due and
reminder instants — never the title.

## HTTP API

| Method and path | CRM action |
|---|---|
| `GET /accounts?search=&role=&ownerId=&status=&limit=&offset=` | read |
| `GET /accounts/{id}` (with its contacts) | read |
| `PATCH /accounts/{id}` `{ ownerId?, segment?, tags? }` | write; `assign` too when `ownerId` is sent |
| `POST /accounts/{id}/contacts` (requires `Idempotency-Key`) | write |
| `GET /contacts/{id}`, `PUT /contacts/{id}`, `PATCH /contacts/{id}/status` | read / write |
| `DELETE /contacts/{id}` — crypto-shredding | erase |
| `GET /owners` | read |
| `GET /pipelines`, `GET /pipelines/{id}`, `GET /sources`, `GET /loss-reasons` (`?archived=include`) | read |
| `POST /pipelines`, `PUT /pipelines/{id}`, `PATCH /pipelines/{id}/status`, `POST /pipelines/{id}/stages`, `PATCH /pipelines/{id}/stages/{stageId}`, `PUT /pipelines/{id}/stage-order` | configure |
| `POST /sources`, `PATCH /sources/{id}`, `POST /loss-reasons`, `PATCH /loss-reasons/{id}` | configure |
| `GET /opportunities?pipelineId=&stageId=&status=&ownerId=&accountId=`, `GET /opportunities/{id}` (with its history, its quotes and its conversion) | read |
| `POST /opportunities` (requires `Idempotency-Key`), `PUT /opportunities/{id}`, `POST /opportunities/{id}/stage`, `…/win`, `…/lose`, `…/reopen` | write |
| `POST /opportunities/{id}/owner` | assign |
| `POST /activities` (requires `Idempotency-Key`), `PUT /activities/{id}` | write |
| `GET /activities/{id}`, `GET /tasks?assigneeId=&accountId=&status=&dueBefore=`, `GET /tasks/{id}`, `GET /notes/{id}` (with its revisions) | read |
| `POST /tasks` (requires `Idempotency-Key`), `PUT /tasks/{id}`, `POST /tasks/{id}/complete`, `…/cancel` | write |
| `POST /tasks/{id}/assignee` | write; `assign` too when the assignee is someone else (also on `POST /tasks`) |
| `POST /notes` (requires `Idempotency-Key`), `POST /notes/{id}/revisions` | write |
| `GET /agenda?until=` — the caller's open tasks due by `until` (default: 24 hours) | read |
| `GET /accounts/{id}/timeline`, `GET /opportunities/{id}/timeline` (`limit`, `offset`) | read |
| `GET /forecast?cutoff=&groupBy=pipeline\|owner\|source&pipelineId=&ownerId=&sourceId=` — open, weighted and won value per month and currency | read |
| `GET /pipelines/{id}/metrics?cutoff=&from=&to=` — entries, exits, conversion and time per stage, win rate, loss reasons | read |

## Authorization

`crm:admin` reads, writes, assigns owners, configures pipelines and lists, and erases
contacts; `crm:manager` does all of that but erase; `crm:representative` reads and writes;
`crm:viewer` reads.
Visibility is tenant-wide: roles are module-scoped (ADR 0023).

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain and application tests; `npm run test:e2e` starts PostgreSQL
with Testcontainers and proves sealed contacts and record text, crypto-shredding, party
erasure, idempotency, the audit chain, reminders sent once by concurrent schedulers, the
timelines and cross-tenant isolation.

With `DATABASE_RELAY_URL` set, the service also runs the outbox relay and the reminder
scheduler (`REMINDER_POLL_INTERVAL_MS`, default 15 s; `REMINDER_BATCH_SIZE`, default 100).
The scheduler reads, as `horizon_relay`, only which tenants have a reminder due; it sends
them per tenant as `horizon_app`, under RLS.

`npm run rebuild:metrics -- --tenant <uuid> [--batch 200] [--verify-only]` rebuilds the
metric rows from the history in batches, printing progress and any drift, and compares
every number at one cutoff before and after. It fails if the numbers changed without
drift, or if drift remains after the rebuild. Run it once after the Phase 59 migration to
fill the rows of older opportunities.

Two one-off commands bring an existing workspace into CRM:

- `npm run republish:parties -- --tenant <uuid>` in `parties/` republishes every live
  party, so the ones that already hold a CRM role become accounts;
- `npm run backfill:owners -- --tenant <uuid>` here loads the workspace's users as
  owners (`IDENTITY_URL`, `IDENTITY_TOKEN`).
