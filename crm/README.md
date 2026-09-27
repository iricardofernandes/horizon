# `crm/`

The accounts the business is trying to win or keep, the people it talks to there, and
who looks after each account.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/crm`, never directly, and it shares no
source with any other module (ADR 0001).

**Status: phase 55 — accounts, contacts and owners.** Opportunities and pipelines arrive
in phase 56, activities and tasks in phase 57 ([CRM plan](../docs/crm-implementation-plan.md)).

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
- **Audit** — every command appends to the tenant's hash chain (ADR 0025), with field
  names and never contact values.

## What it explicitly does not own

- Parties, their documents and contacts: `parties/` is authoritative, and CRM never
  registers an organization itself.
- Quotes and orders: Sales owns them; CRM will hand off to a quote in phase 58 without
  writing to Sales.

## Events

Consumed: `parties.party.registered` and `updated` (v1 and v2), `parties.party.erased`,
`identity.user.registered` and `identity.user.disabled`. Published: none yet — the outbox
and relay are wired for the `crm.opportunity.*` events of phase 56.

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

## Authorization

`crm:admin` reads, writes, assigns owners and erases contacts; `crm:manager` reads,
writes and assigns; `crm:representative` reads and writes; `crm:viewer` reads.
Visibility is tenant-wide: roles are module-scoped (ADR 0023).

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain and application tests; `npm run test:e2e` starts PostgreSQL
with Testcontainers and proves sealed contacts, crypto-shredding, party erasure,
idempotency, the audit chain and cross-tenant isolation.

Two one-off commands bring an existing workspace into CRM:

- `npm run republish:parties -- --tenant <uuid>` in `parties/` republishes every live
  party, so the ones that already hold a CRM role become accounts;
- `npm run backfill:owners -- --tenant <uuid>` here loads the workspace's users as
  owners (`IDENTITY_URL`, `IDENTITY_TOKEN`).
