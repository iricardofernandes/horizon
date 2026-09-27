# Phase 55 — The CRM module, accounts and contacts

Status: **delivered on 2026-09-27** ([evidence](crm-phase55-evidence.md)). This is the execution record for
[Phase 55 of the CRM plan](crm-implementation-plan.md#55--the-crm-module-accounts-and-contacts).
Decisions: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## Result

After this phase:
- a **`crm/` service** runs on port 3012 behind Kong at `/crm`. It has its own database
  (`horizon_crm`), forced RLS, an outbox and an inbox, telemetry, a hash-chained audit
  log, and CI, compose, demo and proxy wiring;
- the **`crm` module** and its roles `admin`, `manager`, `representative` and `viewer` are
  published in `@horizon/contracts` 0.42.0. Every service pins that version before anyone
  can hold a CRM role;
- an **account** is projected from party events for every party that holds `prospect`,
  `customer` or `partner`. The account id is the party id. CRM adds its own fields: owner,
  segment and tags;
- **contacts** (people at an account) are created, edited, deactivated, reactivated and
  erased:
  - their personal fields are sealed under a per-contact key;
  - erasing the contact, or the party behind its account, destroys that key;
- **owners** are the workspace's users, projected from `identity.user.registered` and
  `identity.user.disabled`, with a one-off backfill from the Identity API. A disabled user
  keeps the accounts it owns but cannot be given new ones.

No screen yet: the CRM screens come in Phase 60.

## Starting point

- Parties publishes `parties.party.registered`/`updated` v2, `role-granted`/`revoked` and
  `erased` (Phase 54). The v2 events carry the document type, never the number.
- `identity.user.registered` and `identity.user.disabled` carry only ids and instants: no
  name and no email. Nothing consumes them yet.
- Procurement is the closest template: a NestJS service that consumes events, has an
  outbox relay, idempotent commands and a hash-chained audit log. Parties is the template
  for per-subject keys and crypto-shredding.
- `crm` is reserved with port 3012 in the expansion plan. No role, database or route
  exists.

## Decisions frozen by this plan

1. **What an account projects.** It stores the party's kind, legal and trade name, roles,
   document type and country, and active state. These are what a list needs to show and
   filter.
   - Party contacts (email, phone, address) are not copied. They stay in Parties, and a
     screen reads them from there.
   - An account appears when the party first holds a CRM role. Once projected, it stays:
     - `inactive` when the party is inactive or no longer holds a CRM role;
     - `erased` when the party is erased. Names are then blanked and every contact of the
       account is shredded.
2. **Contacts are CRM data** (ADR 0057).
   - Fields:
     - name;
     - job title, email and phone, all optional;
     - a lawful basis: `contract`, `legitimate-interest` or `consent`.
   - Name, job title, email and phone are sealed with a key per contact, as Parties does
     per party. There is no deployment secret: destroying the key material is the erasure.
   - A contact of an erased or inactive account cannot be created. An erased contact
     cannot be edited.
3. **Owners are ids.**
   - CRM keeps `(userId, active)` and never a name or an email.
   - An owner can be assigned only if the user is known and active.
   - Users who existed before CRM are loaded once with
     `npm run backfill:owners -- --tenant <uuid>`, which reads `GET /identity/users`.
4. **Roles.**

   | Role | Read | Write accounts and contacts | Assign owners | Erase contacts |
   |---|---|---|---|---|
   | `admin` | yes | yes | yes | yes |
   | `manager` | yes | yes | yes | no |
   | `representative` | yes | yes | no | no |
   | `viewer` | yes | no | no | no |

   Visibility stays tenant-wide: roles are module-scoped (ADR 0023), as the CRM plan says.
5. **Account source moves to Phase 56.** The plan listed "the source it came from" as an
   account field. Sources are a configurable tenant list, and Phase 56 introduces that
   list, so the source is added to accounts and opportunities there.
6. **No CRM events yet.** Phase 55 publishes nothing. The outbox table and relay are
   wired now, because the module template includes them and Phase 56 publishes
   `crm.opportunity.*`.
7. **Parties that existed before CRM.**
   - CRM never saw their `registered` event.
   - Parties gains `npm run republish:parties -- --tenant <uuid>`, which emits
     `parties.party.updated` for every live party. Every consumer treats it as a refresh.
   - `parties.party.updated` v2 gains an optional `kind` (additive, in 0.42.0), so a
     projection that starts from an update still knows whether the party is an
     organization or a person.
8. **Audit.** Every command appends to the tenant's hash chain (ADR 0025):
   - account profile change;
   - contact created, revised, deactivated, reactivated or erased.

   Entries carry ids and field names, never contact values.

## Work

### A — Contracts (0.42.0)

1. `crm` joins `MODULES`, `ROLES` and `roleAssignmentSchema`.
   `parties.party.updated` v2 gains the optional `kind`.
2. Every service pins 0.42.0, published to the local Verdaccio. Identity's
   `contracts.spec.ts` acknowledges the module.

### B — `crm/` service

1. Skeleton from Procurement:
   - package, Dockerfile, env, biome, tsconfig and vitest configs, migrate script;
   - `core/`, telemetry, the access-token verifier and the RabbitMQ transport;
   - authorization, command context and request parsing.
2. Domain:
   - `Account` (projection plus profile);
   - `Contact` (sealed fields, status, lawful basis);
   - `Owner`;
   - value objects for segment, tags, contact name, job title, email, phone and lawful
     basis.
3. Application:
   - party projection (v1/v2 with erasure);
   - owner projection;
   - `UpdateAccountProfile`;
   - `CreateContact` (idempotent), `ReviseContact`, `ChangeContactStatus` and
     `EraseContact`.
4. Infrastructure:
   - migration `0000_crm`: `tenants`, `accounts`, `contact_data_keys`, `contacts`,
     `owners`, `inbox`, `outbox`, `command_receipts` and `audit_log`, with forced RLS,
     grants and the outbox tenant trigger;
   - Drizzle store and reads.
5. HTTP:
   - `GET /accounts` (search, role, owner, status, paging);
   - `GET /accounts/{id}` (with contacts);
   - `PATCH /accounts/{id}`;
   - `POST /accounts/{id}/contacts`;
   - `PUT /contacts/{id}`;
   - `PATCH /contacts/{id}/status`;
   - `DELETE /contacts/{id}`;
   - `GET /owners`;
   - health.
6. `backfill:owners` CLI.

### C — Platform wiring (expansion plan checklist)

- `scripts/modules.json` (`crm`, 3012), Makefile `SERVICES` and `demo`;
- `infra/docker-compose.apps.yml` (`crm-migrate`, `crm`);
- `gateway/kong.yml` (`/crm`);
- `infra/postgres/init/01-roles-and-databases.sh`. The local cluster gets `horizon_crm`
  by hand;
- `web/src/lib/upstream-path.ts`;
- `.github/workflows/{golden-path,isolation,release}.yml` and `scripts/ci-local.mjs`;
- `scripts/demo.mjs`: the operator gains `crm:admin`, and the demo migrates `horizon_crm`;
- README module table, ADR index untouched (no new ADR), glossary (account, contact,
  owner).

### D — Evidence

1. Unit tests:
   - account projection rules (roles, inactive, erased, v1/v2);
   - contact rules;
   - owner rules;
   - role map.
2. e2e (testcontainers):
   - contact fields stored only as ciphertext;
   - erasure destroys the key;
   - party erasure shreds the account's contacts;
   - cross-tenant RLS on every table;
   - idempotent contact creation;
   - duplicate events processed once;
   - audit chain written.
3. `scripts/phase55-smoke.mjs` through Kong:
   - a prospect registered in Parties appears as a CRM account;
   - owner backfill, then owner, segment and tags assigned;
   - a contact created, read back, deactivated and erased;
   - erasing the party blanks the account;
   - a `viewer` token is refused on writes;
   - a disabled owner is refused.
4. `make check`, the CRM e2e, `make demo`, `make ci-local`, and isolated jobs for `crm`,
   `contracts` and `identity`.

## Exit evidence

- Cross-tenant and RLS tests cover every table.
- Erasing a party shreds its account's contacts. Erasing a contact leaves its account.
- The smoke registers a prospect in Parties and finds it as a CRM account.

## Revisions made while implementing

- **Republish.** Parties republish instead of a CRM-side backfill, and `kind` becomes
  optional on `parties.party.updated` v2 (decision 7).
- **Demo.** The demo migrates `horizon_crm` and grants `crm:admin`, but does not build the
  module, because it runs none of its code.
- **Connections.** The local Postgres `max_connections` goes from 100 to 200. With CRM,
  twelve services with pools of ten, their relays and the Fiscal worker exhausted the
  default during the first republish.
- **Consumer logging.** The CRM consumer logs the event type and the error class of a
  failed delivery. The template swallowed the error, which left an unexplained dead
  letter in Sales and Procurement undiagnosable (see the evidence).

## Out of scope

- Screens, and CRM roles in the access screen (Phase 60).
- Opportunities, pipelines, sources and loss reasons (Phase 56).
- Activities and tasks (Phase 57).
