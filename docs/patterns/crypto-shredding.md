# Subject keys and crypto-shredding

Source: `identity/src/domain/entities/data-subject-key.ts`,
`identity/src/application/use-cases/erase-data-subject.ts`, the Drizzle user mapper in
`identity-database.ts`, and `identity/src/infrastructure/cryptography/aes-gcm-secret-box.ts`.
Proof: real-crypto unit tests and the database erasure e2e test.

Generate one random 32-byte key per subject. Encrypt personal columns with
authenticated encryption and a context that binds tenant, subject and field. Store a
service-keyed HMAC of normalized email for exact-match lookup; scope that index to the
tenant. Do not implement prefix searches over ciphertext. Fetch subject keys within
the request transaction; never retain an indefinite cross-request plaintext key cache.

On erasure, destroy key material, mark the user erased, drop grants and terminate
sessions. Keep ciphertext byte for byte, including encrypted audit diffs, so retained
hashes still verify. An erased user can be represented by a nonpersonal tombstone for
administrative reads, but cannot authenticate or export the removed plaintext.

The table-backed development key store demonstrates erasure from live data. Backups
that also contain old key material can recover old ciphertext: a separate key backup
and deletion policy or external KMS is required to extend erasure to backups. Do not
claim a table UPDATE destroys historical backups. The production KMS path remains a
later deployment concern and is rejected by the current runtime configuration.

For another module, identify its personal fields and who owns each subject. Consume
`identity.data-subject.erased` idempotently and destroy that module's own subject key.
Test that encryption rejects tampering, another tenant cannot obtain the key, destroyed
material is unavailable and the unchanged audit chain still verifies.
