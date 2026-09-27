# Phase 54 — Parties without a Brazilian document, and CRM decisions

Status: **delivered on 2026-09-27** ([evidence](crm-phase54-evidence.md)). This is the execution record for
[Phase 54 of the CRM plan](crm-implementation-plan.md#54--parties-without-a-brazilian-document-and-crm-decisions).

## Result

After this phase:
- a party's document is **typed**: `cpf`, `cnpj`, `foreign` (country and identifier) or
  `none`. A foreign company, or a person who has not given a CPF, can be registered and
  can become a customer, a supplier or a prospect;
- a party whose document is `none` can be **identified later**, once, without changing
  its id;
- **email, phone and address are optional** in the registry. The roles that need them
  require them: `customer`, `supplier` and `carrier`. A `prospect` or a `partner` needs
  only a name;
- a **duplicate check** finds parties with the same normalized name, email, phone or
  document, and the registration screens warn before creating a lookalike;
- **party events v2** carry the document type and nullable contact fields. Sales,
  Procurement and Financial accept v1 and v2;
- a party that is not identified by a CPF or a CNPJ cannot hold a **fiscal profile**. So
  Fiscal has no recipient projection for it, and refuses an NF-e with its existing
  `DOCUMENT_NOT_READY` code;
- **ADR 0057** records the Phase L decisions.

## Starting point

- `TaxId` accepts only an 11-digit CPF or a 14-character CNPJ. It is paired with the
  kind: person → CPF, organization → CNPJ.
- `parties` stores the tax id as ciphertext plus a keyed blind index
  (`HMAC(tenant:taxId)`), unique per tenant. Email, phone and address are `NOT NULL`
  ciphertext.
- `parties.party.registered` and `parties.party.updated` v1 require email, phone and
  address, and carry no tax id.
- Sales projects parties that hold `customer`, and validates email and phone before it
  looks at the role. Procurement projects `supplier`. Financial keeps the name, roles
  and active flag.
- The fiscal profile export carries `taxId`. Fiscal uses it for the NF-e and NFC-e
  recipient.
- Two screens register parties: Parties (`parties-view.tsx`) and Sales customers
  (`customers-view.tsx`). Both infer the kind from the length of the tax id.

## Decisions frozen by this plan (ADR 0057)

1. **The document is typed, and a party has at most one.**
   - `cpf`: 11 digits, kind `person`.
   - `cnpj`: 14 characters (alphanumeric CNPJ), kind `organization`.
   - `foreign`: an ISO 3166-1 alpha-2 country other than `BR`, and an identifier of 1–40
     letters, digits, `-`, `.` or `/`, stored uppercase. Either kind.
   - `none`: either kind.
   - Uniqueness is per tenant, over a blind index of the document:
     - `cpf` and `cnpj` keep today's index input, so existing rows need no rewrite;
     - `foreign` is indexed with its country;
     - `none` has no index.
2. **A document is set once.** `none` can become any other type through
   `PUT /parties/{id}/document`. Changing an existing document stays unsupported: that
   would be a different party.
3. **Contact fields follow the roles.** `customer`, `supplier` and `carrier` require
   email, phone and address, which is what their consumers need today. The rule is
   checked on registration, on granting one of these roles, and when the details change.
   A party with no role or only `prospect` or `partner` needs only its name.
4. **Events v2 are the only version produced.**
   - `parties.party.registered` v2 and `parties.party.updated` v2 add `documentType`,
     `documentCountry` (foreign only) and nullable `email`, `phone` and `address`.
   - The number is never on the bus, as in v1.
   - Consumers accept v1 (replays and messages already queued) and v2. They are
     deployed before Parties publishes v2.
5. **The fiscal profile needs a CPF or a CNPJ.** Parties refuses it for `foreign` and
   `none` with a 409 that says why. Export NF-e (`idEstrangeiro`) is out of scope, as the
   CRM plan says.
6. **Duplicates are warned about, not blocked.**
   - Parties keeps keyed blind indexes of the normalized name, email and phone. Name
     normalization: lowercase, no accents or punctuation, common company suffixes
     removed.
   - `POST /parties/duplicate-check` returns up to ten matches and what matched.
   - Existing rows get the indexes from `npm run backfill:party-lookups`, per tenant.
   - A document match is still a 409 on registration, as today.
7. **The Phase L boundary** is recorded in the same ADR: CRM module, accounts as parties,
   contacts owned by CRM, the hand-off to a Sales quote, and history as the source of
   metrics (CRM plan, decisions 2–6).

## Work

### A — Contracts (0.41.0)

1. `parties.party.registered` v2 and `parties.party.updated` v2 in `events/parties.ts`,
   registered next to v1. Export `PARTY_DOCUMENT_TYPES`.
2. Snapshot and events doc regenerated. Every consumer is pinned to 0.41.0.

### B — Parties

1. `PartyDocument` value object (four types), replacing `TaxId` in the aggregate.
   `PartyEmail`, `PartyPhone` and `PartyAddress` become optional on the aggregate.
2. Aggregate rules:
   - `register`, `describe` and `grant` check the contact fields the roles need;
   - `identify(document)` works only from `none`;
   - `describeFiscalProfile` refuses anything other than `cpf` or `cnpj`;
   - events are v2.
3. Migration `0002_party_documents.sql`:
   - `document_type`, backfilled from `kind` (organization → `cnpj`, person → `cpf`), and
     `document_country`;
   - `tax_id_ciphertext`, `tax_id_index`, `email_ciphertext`, `phone_ciphertext` and
     `address_ciphertext` become nullable;
   - checks tie the type to the country and the ciphertext;
   - `name_index`, `email_index` and `phone_index` with their tenant indexes.
4. HTTP:
   - registration takes `document` or the old `taxId` shorthand (exactly one), and
     optional contact fields;
   - `PUT /parties/{id}/document`;
   - `POST /parties/duplicate-check`;
   - responses gain `document { type, country, suffix }` and nullable contact fields.
     `taxIdSuffix` stays.
5. `backfill:party-lookups -- --tenant <uuid>` fills the lookup indexes of older rows,
   and changes nothing when run again.

### C — Consumers

1. **Sales:**
   - handles both versions;
   - ignores a party that never was a customer before validating its details;
   - for an existing customer, keeps the stored contact value when an update carries
     `null`.
2. **Procurement:** the same rules for suppliers.
3. **Financial:** handles both versions.

### D — Web

1. A shared document field: type (CPF/CNPJ, foreign, none), country for foreign, and the
   kind chosen explicitly when it cannot be inferred.
2. Parties and Sales customers registration:
   - use the shared field;
   - contact fields are required only when the chosen roles need them;
   - a duplicate check runs before submitting, and the person must confirm to go on.
3. The parties table shows the document type and suffix. An "Inform document" action
   appears for parties with `none`. Null contacts render as "—".
4. pt-BR and en messages.

### E — Evidence

1. Unit tests:
   - document value object;
   - completeness per role;
   - `identify`;
   - fiscal profile refusal;
   - v1/v2 consumer handling in Sales, Procurement and Financial.
2. Parties e2e (testcontainers):
   - foreign and undocumented registration;
   - foreign document uniqueness;
   - `identify`;
   - duplicate check;
   - migration backfill of `document_type`;
   - RLS on the new lookups.
3. `scripts/phase54-smoke.mjs` on the local stack:
   - a foreign company and a person without a CPF, both customers;
   - both appear in Sales and receive a quote;
   - a prospect with only a name;
   - a duplicate warning;
   - the fiscal profile refusal.
4. `make check`, the touched e2e suites and the goods golden path.
5. Evidence record, ADR 0057, glossary (document types), privacy notes (foreign
   identifier is personal data, encrypted like the CPF), Parties README, `plan.md`.

## Exit evidence

- A foreign company and a person without a CPF are registered, become customers, and
  receive a quote.
- A prospect is registered with only a name, and a duplicate check finds it.
- Existing parties keep their ids and documents: the migration types them as `cpf` or
  `cnpj`, and their blind indexes are unchanged.
- A v1 event and a v2 event with the same data give the same projection in Sales,
  Procurement and Financial.
- The goods golden path is unchanged.

## Revisions made while implementing

- The web sends a Brazilian number through the `taxId` shorthand. The registry decides
  CPF or CNPJ and keeps the message people already know for a malformed one.
- The "keep the last known contact" rule lives in `Customer.refresh` and
  `Supplier.refresh`, not in the projection use cases. ADR 0031 keeps snapshots out of
  the application layer.
- The duplicate check returns the aggregates, and the controller presents them.
- The migration lifts forced RLS during its backfill `UPDATE`. Without that, the owner
  sees no rows (same pattern as the Financial `0002_payables`).
- Two screen defects are fixed because the new form needs them:
  - the select popup now opens over dialogs;
  - a field next to one with help text no longer stretches.

## Out of scope

- NF-e for a foreign recipient (`idEstrangeiro`) and NFC-e without a recipient.
- Merging duplicate parties.
- Check-digit validation of CPF and CNPJ (unchanged from today).
