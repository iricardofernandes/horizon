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
ownership; retain canonical serialization byte for byte. A chain detects modification
and interior removal relative to retained links. Detecting a privileged deletion of
the entire tail also needs an independently stored checkpoint; the local verifier
does not promise that property. Test concurrent appends, tampering, privilege mistakes
and erasure with PostgreSQL rather than relying only on hash unit tests.
