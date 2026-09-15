# 40. A shared party registry, with role-fed projections

- Status: accepted
- Date: 2026-09-15

## Context

Today the only counterparty in the system is `sales/`'s customer aggregate, which owns
its own encrypted personal data and its own tax identifier. The operational ERP adds
suppliers to `procurement/`, payers and payees to `financial/`, issuers and recipients to
`fiscal/`, and accounts and prospects to `crm/`.

If each context registers its own counterparties, the same company becomes five rows with
five identifiers, five tax-identifier uniqueness rules and five places to erase personal
data under LGPD. The failure is not theoretical: a supplier who is also a customer is
ordinary in this market, and netting a payable against a receivable requires knowing that
both belong to one legal person.

Erasure makes the duplication worse. Crypto-shredding (ADR 0026) works because a data
subject's key has one owner. Five owners means erasure is a distributed protocol that can
partially succeed.

## Decision

A `parties/` context owns the identity of every organization and natural person the
business deals with: legal and trading names, tax identifiers, contacts, addresses,
payment details, tags and attachments. It owns their encryption keys and their erasure.

A party holds **roles** — customer, supplier, carrier, prospect, partner — as assignments,
not as types. One party may hold several at once.

Consuming contexts do not call `parties/` inside a write path. Each keeps a local,
event-fed projection containing only the fields it needs, keyed by the party id. `sales/`
migrates its customer aggregate into such a projection while keeping its existing public
identifiers, so no client of the Sales API observes the change.

Tax-identifier uniqueness is enforced once, in `parties/`, per tenant.

## Consequences

- One legal person has one id across Sales, Purchasing, Finance, Fiscal and CRM, so
  netting, statements and party-level reporting are possible without a matching heuristic.
- One erasure point. A subject's key is destroyed in `parties/`, and projections carry
  only what their context needs, which is the data that erasure must reach.
- Projections are eventually consistent. A party edited in `parties/` is momentarily stale
  in Sales. The user-visible rule is that a document already posted carries a snapshot of
  the party as it was, so staleness never changes a posted document.
- A migration is required for existing customers, and it must preserve identifiers,
  encrypted fields and audit history rather than re-creating rows.
- Cross-context joins against party data remain forbidden; a context that needs a field it
  does not project must extend its projection and backfill it from the event history.

## Alternatives considered

**A shared party table read by every service.** Simplest to write and incompatible with
one database per module (ADR 0016). It converts an independent-deployability decision into
a shared-schema coupling, and the first migration would block every service.

**Duplicating counterparties per context, reconciled by tax identifier.** No new service,
but the reconciliation is a permanent background problem, and erasure and merging become
best-effort operations across five owners.

**Synchronous calls to `parties/` in write paths.** Keeps the projection code out of the
plan, at the cost of making every sales order depend on the availability of another
service — the coupling that ADR 0027's resilience policy exists to avoid.
