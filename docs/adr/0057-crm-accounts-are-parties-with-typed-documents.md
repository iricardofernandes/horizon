# 57. CRM accounts are parties, and a party's document is typed

- Status: accepted; Phase 54 implements the typed document, the role-driven contact
  fields, the duplicate check and party events v2. Phases 55–60 implement the CRM module.
- Date: 2026-09-27

## Context

Phase L (phases 54–60) adds a CRM: accounts, contacts, opportunities in configurable
pipelines, activities, and the hand-off to a Sales quote.

ADR 0040 made `parties/` the single registry of organizations and people. It assumed that
every party has a Brazilian tax identifier, and the registry enforces it: a CPF for a
person, a CNPJ for an organization, plus an email, a phone and an address. That excludes
two ordinary cases:
- a foreign customer or supplier, identified in its own country or not at all;
- a prospect known only by name, or a person who has not given a CPF.

A CRM that cannot hold these cannot be the front of the sales funnel. And a second
registry of "leads without a document" would recreate the duplication and the split
erasure that ADR 0040 removed.

## Decision

### The party's document

1. **A party has at most one typed document:**
   - `cpf` for a person;
   - `cnpj` for an organization;
   - `foreign`, with an ISO 3166-1 country other than Brazil and a free identifier;
   - `none`.
2. **Uniqueness per tenant** applies to a document that is present. It goes through a
   keyed blind index, as before. CPF and CNPJ keep their index input unchanged.
3. **A document is set once.** A party with `none` can be identified later. Changing an
   existing document is unsupported, because it would describe a different party.
4. **Contact fields follow the roles.**
   - `customer`, `supplier` and `carrier` require email, phone and address, which is what
     their consumers use.
   - `prospect`, `partner` or no role at all require only a name.
5. **Only a CPF or a CNPJ can carry a fiscal profile.** Brazilian fiscal documents to a
   foreign recipient (export) are a later decision. Until then, Fiscal has no recipient
   projection for such a party and refuses the document visibly.
6. **Duplicates are warned about, not prevented.** Without a document there is no
   uniqueness key. The registry keeps keyed blind indexes of the normalized name, email
   and phone, and answers a duplicate check before registration.
7. **`parties.party.registered` and `parties.party.updated` move to v2.**
   - v2 carries the document type and its country, never the number.
   - Contact fields are nullable in v2.
   - Consumers accept both versions, and are deployed before the producer.

### The CRM boundary

1. **`crm/` is its own module** (port 3012). Unlike services (ADR 0056), it shares no
   price list, stock or numbering with Sales. Its aggregates have their own lifecycle and
   history.
2. **An account is a party** that holds `prospect`, `customer` or `partner`, projected
   from party events. CRM never registers organizations. It asks `parties/` to, and
   follows the event.
3. **Contacts belong to CRM.** A contact is a person at an account. It plays no commercial
   role, needs no document, and its personal fields are encrypted under its own key.
   Erasing the contact or its account's party shreds them.
4. **CRM never writes to Sales.**
   - Sales projects open opportunities from `crm.*` events.
   - A quote may name an opportunity. Sales copies the source and the owner from its own
     projection and freezes them on the quote.
   - Converting a prospect first grants it `customer` in `parties/`.
   - CRM follows `sales.quote.*` to close the opportunity as won.
5. **Opportunity history is append-only** and is the source of truth for forecasts and
   conversion metrics. Those are projections that can be rebuilt.

## Consequences

- A foreign customer, or a person with no CPF, is one party with one id across Sales,
  Purchasing, Finance and CRM.
- Such a customer can receive quotes, orders and receivables. It cannot receive an NF-e
  until export is supported, and Fiscal says so rather than failing silently.
- Duplicates become possible for parties without a document. The warning reduces them,
  and merging parties would need its own ADR.
- Every party consumer handles two event versions for a while. v1 remains readable for
  replays.
- Older rows need a one-off backfill of the lookup indexes. Until it runs, the duplicate
  check does not see them.

## Alternatives considered

**A CRM-owned lead that becomes a party when qualified.** It keeps the registry strict,
but it creates a second store of people and companies, with its own deduplication and
its own erasure. The user decided that customers without a Brazilian document are
ordinary, so the registry has to hold them anyway.

**Making the tax id optional without a type.** Simpler, but it cannot tell "not given
yet" from "foreign". It also has no way to keep foreign identifiers unique, or to say why
a fiscal document is refused.

**Emitting v1 and v2 side by side.** The envelope policy allows it during a deprecation
window. But a party without an email cannot be expressed in v1, so v1 would be emitted
for some parties and not others, and consumers would process most facts twice.
