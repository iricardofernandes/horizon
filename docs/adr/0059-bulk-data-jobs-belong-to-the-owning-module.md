# 59. Bulk data jobs belong to the module that owns the data

- Status: accepted; Phase 63 implements exports, Phase 64 imports.
- Date: 2026-09-27

## Context

Going live on an ERP means loading what the business already has:
- customers and suppliers;
- items and prices;
- stock on hand;
- open receivables and payables.

Running it means taking data out: for an accountant, an auditor or a spreadsheet. The
only bulk path today is the bank statement import of Phase 20, built for one file type
inside Treasury.

A central "import service" would be the quickest to build. It would also write into
other modules' tables or call their write endpoints on everyone's behalf, which is
exactly what ADR 0016 and ADR 0047 exist to prevent. And it would have to re-implement
each module's validation, which then drifts.

## Decision

### Imports

1. An import is a **job inside the owning module**. The rows go through the module's own
   use cases, with its own validation, audit and events.
2. **Every module implements the same job contract,** published in `@horizon/contracts`:
   - states: `uploaded → validated → previewed → running → completed |
     completed-with-failures | cancelled`;
   - a progress shape: rows total, valid, written, failed, remaining;
   - a failures file.
3. **Rows are written in batches.** Each row carries a key derived from the job and its
   row number, so a crash and a resume never write a row twice. Importing the same file
   again under the same job key writes nothing.
4. **A failed row stays in the job with its reasons.** The failures download in the
   input's own format, with a reason column.
   - The job counts always add up to the file's rows.
   - "Completed" is never shown while any row is unaccounted for.

### Exports

5. **Exports of reports** are jobs in `reporting/`. They carry the report's cutoff and
   whether it was settled.
6. **Exports of an operational list** are streamed by the web server from the owning
   module's paginated API, as the signed-in user.
   - They are limited to a declared number of rows. Above it, the screen offers the
     report export.
   - Authorization is unchanged, because nothing runs with more than the user's roles.

### Files and formats

7. **Files live in object storage** under a tenant prefix and download through
   short-lived signed links. They expire by retention (ADR 0063).
8. **Formats:**
   - CSV in UTF-8 with a BOM, with `;` as the separator in pt-BR and `,` in English;
   - XLSX.

   A cell starting with `=`, `+`, `-` or `@` is quoted, so a spreadsheet never runs it as
   a formula.

## Consequences

- Every importer is only as complex as its module's rules, and its tests are that module's
  tests.
- The job contract is repeated in each module that imports. Modules share no code, but
  the published contract and a shared e2e checklist keep the behaviour the same.
- The web import wizard is generic: it drives any module that implements the contract.
- An operational list export can never show more than the list screen could.

## Alternatives considered

- **A central import service calling write endpoints.** One codebase, but it holds
  credentials for every module, and its failures become every module's support problem.
- **Direct SQL loads.** Fast, but it bypasses validation, audit and events. The first
  report after go-live would not reconcile.
- **Exports from `reporting/` for every list.** It would need a projection of every
  operational table, and would still lag the screen the user is looking at.
