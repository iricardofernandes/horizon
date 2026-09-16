# `parties/`

Every organization and person the business deals with, recorded once, with the roles
each one plays.

An independently deployable NestJS service with its own database, its own container and
its own lifecycle. It is reached through Kong at `/parties`, never directly, and it shares
no source with any other module (ADR 0001).

**Status: phase 15 — complete.**

---

## What this context owns

- **Parties** — legal and trade name, CPF or CNPJ, email, phone and address (ADR 0040).
- **Roles** — `customer`, `supplier`, `carrier`, `prospect`, `partner`, held as a set.
- **Tax-identifier uniqueness** per tenant, answered through a keyed blind index.
- **Erasure** — each party has its own data key; destroying it is the erasure (ADR 0026).

## What it explicitly does not own

- What a customer has bought or a supplier has delivered: Sales, Purchasing and Finance
  keep their own projections, fed by events, and never query this database.
- Contacts, multiple addresses, bank details and attachments — later phases.

## Events published

`parties.party.registered`, `parties.party.updated`, `parties.party.role-granted`,
`parties.party.role-revoked` and `parties.party.erased`, all at version 1. A role change is
followed by `parties.party.updated` in the same transaction, so a consumer that was not
projecting the party yet receives its details. No event carries the tax identifier, and
the erasure event carries only the party id.

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
