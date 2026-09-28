# 60. Attachments are a `files` module, scanned before served and shredded with their owner

- Status: accepted; implemented in Phase 65 ([evidence](../readiness-phase65-evidence.md)).
- Date: 2026-09-27

## Context

Businesses attach documents to records:
- a supplier's contract to the party;
- a quote PDF to a purchase order;
- a receipt to a payable;
- a signed report to a service order;
- a proposal to an opportunity.

Horizon has object storage (MinIO) only for Fiscal's own artifacts.

Attachments share one lifecycle whatever the record: upload, scan, serve, retain, erase.
Modules share no source code (ADR 0001), so putting attachments in each module means
writing that lifecycle ten times. A file is also the most likely place for malware and
for personal data nobody catalogued.

The expansion plan closed the module list at `reporting`. This decision reopens it once.

## Decision

1. **Ownership.** `files/` is a module of its own, on port 3014, with its own database
   and a bucket per environment.
2. **Record reference.** An attachment references `(module, recordType, recordId)`. It is
   listed, uploaded and read by a user who holds the owning module's `read` or `write`
   role, checked from the token like any route (ADR 0023).
3. **Module name.** `files` holds no roles of its own, so it needs no module name in
   contracts until it becomes an API-key scope.
4. **Lifecycle:** `uploading → scanning → available | quarantined → deleted`. A file is
   served only when `available`, through a short-lived signed link.
5. **Scanning** is a port:
   - ClamAV in the local stack;
   - a deterministic adapter that flags the EICAR test file in CI.

   A scanner failure leaves the file in `scanning`. It never releases it.
6. **Encryption and erasure.**
   - Each file is encrypted under a key of its owner: the party, or the user who uploaded
     it.
   - `parties.party.erased` and `identity.data-subject.erased` destroy the key: the same
     crypto-shredding as ADR 0026.
   - Events carry no file name.
7. **Retention** is declared per record type. Expiry is a job that logs what it removed,
   never a silent delete.

## Consequences

- Every module gains attachments with no storage code of its own. The web gains one
  attachments panel.
- **Record existence.** `files/` cannot prove a record exists without asking its module.
  It relies on the tenant boundary and the module role. An attachment to a mistyped id is
  harmless and invisible.
- **Rollout.** A new service joins the stack, with the full wiring checklist.

## Alternatives considered

- **Attachments inside each owning module.** Strong ownership, and ten copies of upload,
  scanning, encryption and retention that drift apart.
- **A shared published library.** It would move the duplication into a package every
  module must upgrade in lockstep, and still give each module its own bucket and its own
  scanner.
- **Attachments in `reporting/`.** It would give a read model the power to hold and serve
  business documents, breaking ADR 0047's purpose.
