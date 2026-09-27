# `parties/`

Every organization and person the business deals with, recorded once, with the roles
each one plays.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/parties`, never directly, and it shares
no source with any other module (ADR 0001).

**Status: phase 15 — complete; typed documents and the duplicate check since phase 54.**

---

## What this context owns

- **Parties** — legal and trade name, a typed document, email, phone and address
  (ADR 0040, ADR 0057). The document is a `cpf`, a `cnpj`, a `foreign` identifier with its
  ISO country, or `none`; a `none` is completed once through `PUT /parties/{id}/document`.
- **Contacts follow the roles** — `customer`, `supplier` and `carrier` require email,
  phone and address; a `prospect` or `partner` may be known by name alone.
- **Roles** — `customer`, `supplier`, `carrier`, `prospect`, `partner`, held as a set.
- **Document uniqueness** per tenant, answered through a keyed blind index; a foreign
  document is unique within its country, and parties without one never collide.
- **Duplicate check** — `POST /parties/duplicate-check` answers which live parties share
  the normalized name, email, phone or document of a probe, through keyed indexes.
- **Fiscal profiles** only for a CPF or a CNPJ; a foreign or undocumented party is refused
  with a 409 until export documents are supported.
- **Erasure** — each party has its own data key; destroying it is the erasure (ADR 0026).

## What it explicitly does not own

- What a customer has bought or a supplier has delivered: Sales, Purchasing and Finance
  keep their own projections, fed by events, and never query this database.
- Contacts, multiple addresses, bank details and attachments — later phases.

## Events published

`parties.party.registered` and `parties.party.updated` at version 2 (the document type
and country, nullable contact fields — ADR 0057), and `parties.party.role-granted`,
`parties.party.role-revoked`, `parties.party.erased` and
`parties.party.fiscal-profile-changed` at version 1. A role change is followed by
`parties.party.updated` in the same transaction, so a consumer that was not projecting the
party yet receives its details. No event carries the document number, and the erasure
event carries only the party id.

## Authorization

`parties:admin` reads, manages and erases; `parties:editor` reads and manages;
`parties:viewer` reads. Until every workspace grants a `parties` role, a Sales role keeps
read and manage — never erase — so existing sales teams are not locked out.

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain tests; `npm run test:e2e` starts PostgreSQL and RabbitMQ with
Testcontainers and proves encryption at rest, tax-identifier uniqueness, identifier
adoption, crypto-shredding and cross-tenant isolation.

Existing Sales customers are brought into the registry, keeping their ids, with
`make migrate-customers` from the repository root.

Parties registered before Phase 54 get their duplicate-check indexes once, per tenant:
`npm run backfill:party-lookups -- --tenant <uuid>` (it changes nothing when run again).

A consumer that starts after the parties were registered — CRM in Phase 55 — receives them
with `npm run republish:parties -- --tenant <uuid>`, which emits `parties.party.updated`
(with the kind) for every live party. Every consumer treats it as a refresh.
