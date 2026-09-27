# CRM API reference

The CRM lives in `crm/` ([ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md),
[CRM plan](crm-implementation-plan.md)).
- **Paths:** through Kong every path below is prefixed with `/crm`; the web proxies it as
  `/api/horizon/crm`.
- **Formats:** money is `{ amount, currency }` with the amount in minor units as a string.
  Business dates are `YYYY-MM-DD`; instants are ISO 8601 with an offset.

Conventions:
- **Roles:**

  | Action | Roles |
  |---|---|
  | `read` | any CRM role |
  | `write` | `admin`, `manager`, `representative` |
  | `assign` | `admin`, `manager` |
  | `configure` | `admin`, `manager` |
  | `erase` | `admin` |

  Visibility is tenant-wide (ADR 0023).
- **Idempotency:** commands that create a record require an `Idempotency-Key` header. A
  retry with the same key and body answers what the first call answered; the same key with
  another body gets `409` (ADR 0028).
- **Errors:**
  - `400` for invalid input;
  - `403` for a role that may not act;
  - `404` for an unknown record;
  - `409` for a refusal of the record's own state, with its reason in `message`.
- **Pages:** lists take `limit` (1–200, default 50) and `offset`, and answer
  `{ data, page: { limit, offset, total } }`.

Events are listed in [events.md](events.md); the personal data and its erasure in
[privacy.md](privacy.md); the threats in [crm-threat-model.md](crm-threat-model.md).

## Accounts, contacts and owners

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `GET` | `/accounts?search=&role=&ownerId=&status=` | read | | Accounts: parties holding `prospect`, `customer` or `partner` |
| `GET` | `/accounts/{id}` | read | | One account with its contacts |
| `PATCH` | `/accounts/{id}` | write (+ assign for `ownerId`) | | `ownerId`, `sourceId`, `segment`, `tags` |
| `POST` | `/accounts/{id}/contacts` | write | yes | A person at the account: `name`, `jobTitle`, `email`, `phone`, `lawfulBasis` |
| `GET` | `/contacts/{id}` | read | | One contact; an erased one has no name or contacts left |
| `PUT` | `/contacts/{id}` | write | | Replace a contact's details |
| `PATCH` | `/contacts/{id}/status` | write | | `{ active }` |
| `DELETE` | `/contacts/{id}` | erase | | Crypto-shredding: the contact's key is destroyed |
| `GET` | `/owners` | read | | Workspace users as ids, and whether they may be given work |

A new account is a party registered in Parties with the `prospect` role
(`POST /parties/parties`); CRM projects it from the registry's event.

## Pipelines and lists

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `GET` | `/pipelines?archived=include` | read | | Pipelines with their ordered stages |
| `GET` | `/pipelines/{id}` | read | | One pipeline |
| `POST` | `/pipelines` | configure | yes | `name`, `stages[]` (`name`, `probabilityBps` 0–10000) |
| `PUT` | `/pipelines/{id}` | configure | | Rename: `name` |
| `PATCH` | `/pipelines/{id}/status` | configure | | `{ archived }` |
| `POST` | `/pipelines/{id}/stages` | configure | | Add a stage |
| `PATCH` | `/pipelines/{id}/stages/{stageId}` | configure | | `name`, `probabilityBps`, `archived` |
| `PUT` | `/pipelines/{id}/stage-order` | configure | | `stageIds[]`, every stage once |
| `GET` | `/sources`, `/loss-reasons` (`?archived=include`) | read | | Workspace lists |
| `POST` | `/sources`, `/loss-reasons` | configure | yes | `name`, unique among active entries |
| `PATCH` | `/sources/{id}`, `/loss-reasons/{id}` | configure | | `name`, `archived` |

## Opportunities

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `GET` | `/opportunities?pipelineId=&stageId=&status=&ownerId=&accountId=` | read | | Opportunities |
| `GET` | `/opportunities/{id}` | read | | One opportunity with its `history` (every fact), its `quotes` (latest version of each offer) and its `conversion` |
| `POST` | `/opportunities` | write | yes | `accountId`, `ownerId`, `pipelineId`, `stageId`, `title`, `expectedValue`, `expectedCloseOn`, optional `sourceId` and `contactIds` |
| `PUT` | `/opportunities/{id}` | write | | Revise title, contacts, source, value and close date |
| `POST` | `/opportunities/{id}/stage` | write | | Move: `stageId` (an active stage) |
| `POST` | `/opportunities/{id}/owner` | assign | | Reassign: `ownerId` (an active owner) |
| `POST` | `/opportunities/{id}/win` | write | | Won by hand |
| `POST` | `/opportunities/{id}/lose` | write | | `lossReasonId`, optional `note` |
| `POST` | `/opportunities/{id}/reopen` | write | | `stageId`; refused for an opportunity converted by a quote |

**Convert to quote.** The web runs three calls; CRM itself calls nobody:
1. `PUT /parties/parties/{accountId}/roles/customer` with `{ "operation": "grant" }`, when
   the account is still a prospect. A customer needs an email, a phone and an address.
2. Wait until `GET /sales/customers` lists the account.
3. `POST /sales/quotes` with `customerId`, `opportunityId` and the lines.
   - Sales freezes the owner and source from its own projection. A body carrying them is
     refused with `400`.
   - When the quote is accepted, CRM converts the opportunity from the event.

```http
POST /sales/quotes
Idempotency-Key: 6f1c…
{ "customerId": "0194…", "opportunityId": "0194…", "lines": [{ "lineId": "0194…", "itemId": "0194…", "quantity": "2" }] }

201 { "quoteId": "0194…", "expiresAt": "2026-10-12T15:00:00.000Z", "total": "2500" }
```

## Activities, tasks and notes

Each record has a `subject`: `{ "type": "account" | "contact" | "opportunity", "id" }`.
- CRM stores the account from the subject.
- Record text is sealed under a key of the account and shredded with its party.

| Method | Path | Action | Key | What it does |
|---|---|---|---|---|
| `POST` | `/activities` | write | yes | `subject`, `kind` (`call`, `meeting`, `email`, `visit`), `occurredAt` (not in the future), `title`, optional `summary` and `contactIds` |
| `GET` | `/activities/{id}` | read | | One activity |
| `PUT` | `/activities/{id}` | write | | Correct what was recorded |
| `GET` | `/tasks?assigneeId=&accountId=&status=&dueBefore=` | read | | Tasks, by due instant; each flagged `overdue` |
| `GET` | `/tasks/{id}` | read | | One task, with `remindedAt` once its reminder was sent |
| `POST` | `/tasks` | write (+ assign for someone else) | yes | `subject`, `assigneeId`, `title`, `dueAt`, optional `remindAt` (not after `dueAt`) |
| `PUT` | `/tasks/{id}` | write | | Revise title and schedule; a new schedule arms the reminder again |
| `POST` | `/tasks/{id}/assignee` | write (+ assign for someone else) | | `assigneeId` |
| `POST` | `/tasks/{id}/complete`, `/tasks/{id}/cancel` | write | | Close the task |
| `POST` | `/notes` | write | yes | `subject`, `body` |
| `GET` | `/notes/{id}` | read | | The note with every revision |
| `POST` | `/notes/{id}/revisions` | write | | Correct it: a new revision, the earlier text kept |
| `GET` | `/agenda?until=` | read | | The caller's open tasks due by `until` (default 24 hours) |
| `GET` | `/accounts/{id}/timeline`, `/opportunities/{id}/timeline` | read | | Activities, tasks, notes and opportunity facts, newest first: `{ kind, at, record }` |

## Forecast and metrics

Both take `cutoff` (an instant; default now; never in the future). They answer the cutoff
and `settled`, which is true once the cutoff is ten minutes old: from then on, its numbers
cannot change.

| Method | Path | Action | What it answers |
|---|---|---|---|
| `GET` | `/forecast?cutoff=&groupBy=pipeline\|owner\|source&pipelineId=&ownerId=&sourceId=` | read | Per month and currency: open count and value (by expected close month), weighted value (value × stage probability), won count and value (by the month won) |
| `GET` | `/pipelines/{id}/metrics?cutoff=&from=&to=` | read | Per stage: entered, in it at the cutoff, exits (moved, won, lost), time in stage (count, average and median seconds). Stage-to-stage conversions, win rate (basis points), loss reasons |

`npm run rebuild:metrics -- --tenant <uuid> [--batch 200] [--verify-only]` (in `crm/`)
rebuilds the metric rows from the history and compares every number at one cutoff.
