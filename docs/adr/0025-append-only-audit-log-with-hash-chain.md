# 25. Append-only audit log with a per-tenant hash chain

- Status: accepted
- Date: 2026-09-07

## Context

An audit log answers "who changed this, when, and to what". Its value depends entirely
on being trustworthy, and an audit table that the application can update or delete is
not evidence — anyone who can reach the application can rewrite history, and nothing
distinguishes an intact log from a doctored one.

Two properties are needed: writes cannot be undone, and tampering is **detectable**
even by someone who has full database access.

## Decision

A **local `audit_log` table inside each module** (ADR 0003: there is no central audit
service).

**Append-only, enforced twice:**

- `REVOKE UPDATE, DELETE` on the table from the application role.
- A trigger that raises on `UPDATE` or `DELETE`, so that if privileges are ever
  restored by mistake the prohibition still holds.

**Hash-chained per tenant:** every row carries `previous_hash`, and

```
hash = sha256(previous_hash || canonical_json(payload))
```

The chain is per tenant, so one tenant's write volume does not serialise another's, and
a verification pass is scoped to the tenant being investigated.

A **verification command** walks a tenant's chain and reports the first broken link —
"chain is intact through row N; row N+1 does not match" — rather than a boolean.

**Recorded per entry:** actor, tenant, subject type and id, action, before/after diff,
request id, trace id, source IP, timestamp.

**Redaction:** sensitive fields are redacted **before** hashing, and **the redaction
list is itself part of the hashed payload.** This is the subtle part and the reason it
is spelled out: if the list were outside the hash, an attacker could hide a change by
retroactively declaring the changed field sensitive, and the chain would still verify.
Inside the hash, altering what was redacted breaks the chain exactly as altering the
data would.

## Consequences

- Tampering is detectable by anyone with read access and the verification command,
  including an auditor who does not trust the operators.
- Deleting a row breaks the chain at that point and the verifier names it.
- The application literally cannot correct an audit entry. A correction is a new entry
  that references the earlier one.
- Writes serialise per tenant, since each row needs its predecessor's hash. Acceptable
  at ERP write volumes; if it ever binds, the chain becomes per (tenant, subject type)
  rather than per tenant.
- Canonical JSON must be genuinely canonical: sorted keys, a fixed number format, a
  fixed timestamp format (ADR 0011), explicit `bigint` handling (ADR 0010). A chain
  that verifies on one machine and not another is worse than no chain. This is a
  dedicated, heavily-tested function.
- **The retention conflict is real**: an append-only log cannot delete personal data,
  and erasure law requires exactly that. The resolution is crypto-shredding (ADR 0026),
  which is why these two ADRs must be read together.
- Answering "everything this user did across Horizon" requires querying five modules.
  Accepted; see ADR 0003.

## Alternatives considered

**A plain audit table with no chain.** Rejected: it records history without protecting
it, which is the property that makes it worth having.

**Write-only append to an external store (S3 with object lock, a managed ledger).**
Stronger — the operator genuinely cannot alter it. Rejected as infrastructure a
portfolio project cannot demonstrate without a cloud account, and the hash chain gives
detectability, which is most of the value.

**Signing each entry with a private key instead of chaining.** Proves authorship but not
completeness: entries can still be deleted without trace. A chain detects deletion.
Signing the chain head periodically is the natural future addition.

**A central audit service.** Rejected in ADR 0003: a synchronous dependency on every
write path in the system.
