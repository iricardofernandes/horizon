# Append-only audit chains

Source: `identity/src/domain/audit/`, `identity/src/application/use-cases/verify-audit-chain.ts`,
`identity/src/infrastructure/database/drizzle/identity-database.ts`, and
`identity/src/infrastructure/cli/verify-audit.ts`. Proof: audit unit tests and
`identity/test/database.e2e-spec.ts`.

A module owns its own audit table. Revoke mutation privileges and install a trigger
rejecting UPDATE, DELETE and TRUNCATE, including privileged accidental mutations.
Append under a tenant-specific lock, deriving the next sequence and previous hash
inside the same transaction. Serialize objects canonically and hash
`previous_hash || canonical_json(payload)` as UTF-8 using SHA-256.

Redact named secrets recursively, including objects in arrays, before hashing. Include
the redacted-path list in the hashed payload. Encrypt subject-related diffs before
hashing so key destruction leaves the chain unchanged. Record actor, subject, action,
request and trace identifiers, occurrence time and the encrypted before/after diff.

Run `npm run audit:verify -- <tenant-uuid>` in Identity with its application database
URL and blind-index key configured. The command pages through the chain and returns
nonzero on a broken link, naming the first failing sequence. Batch sizes are bounded
and must be positive integers. The HTTP administrative endpoint invokes the same use case.

For another module, change the action vocabulary, sensitive fields and subject-key
ownership; retain canonical serialization byte for byte. Where the module stores no
personal data, say so and keep the diffs in the clear — but keep the redacted-path list
inside the hashed payload regardless, or introducing redaction later changes the format
of a chain that already exists.

**The lock is a per-module decision.** Identity serializes appends on the tenant row, which
needs `UPDATE` on `tenants`. Catalog's application role holds only `SELECT` and `INSERT`
there, because it mirrors tenants rather than owning them, and `SELECT … FOR NO KEY UPDATE`
requires `UPDATE`. Granting a write privilege to obtain a lock trades something real for a
synchronisation primitive; a transaction-scoped advisory lock keyed by tenant is the
primitive, and it is released by commit or rollback either way. Whichever is used, prove it
with concurrent appends against PostgreSQL — consecutive sequence numbers, no gap and no
duplicate. A chain detects modification
and interior removal relative to retained links. Detecting a privileged deletion of
the entire tail also needs an independently stored checkpoint; the local verifier
does not promise that property. Test concurrent appends, tampering, privilege mistakes
and erasure with PostgreSQL rather than relying only on hash unit tests.
