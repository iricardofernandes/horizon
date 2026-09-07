# 26. Crypto-shredding for LGPD/GDPR erasure

- Status: accepted
- Date: 2026-09-07

## Context

Two requirements of this system are, taken literally, mutually exclusive.

LGPD Art. 18 and GDPR Art. 17 give a data subject the right to erasure: on request,
their personal data must be deleted.

ADR 0025 establishes an append-only, hash-chained audit log. Deleting a row breaks the
chain. Modifying a row breaks the chain. The chain's entire value is that it cannot be
altered — which is precisely what erasure demands.

Neither requirement can be dropped. An ERP operating in Brazil and serving European
customers must satisfy erasure; an audit log that can be quietly rewritten is not an
audit log. This is a genuine engineering problem with a non-obvious solution, and it is
given real weight because it is legible in every jurisdiction and it is the kind of
constraint most systems discover far too late.

## Decision

**Crypto-shredding.** Erasure destroys the *key*, not the *row*.

- Personal data columns are **encrypted with a per-data-subject key**.
- Keys live in a `data_subject_keys` table, and in the Terraform definition in AWS KMS.
- **Erasure destroys the key.** The ciphertext remains exactly where it was, byte for
  byte. The hash chain still verifies, because nothing it hashed has changed. The
  plaintext is unrecoverable by anyone, including the operator.
- What survives erasure is the *shape* of history — that an entity existed, that an
  action occurred at a time, that a record was changed — with the personal content
  cryptographically destroyed. That is the correct outcome: the audit trail's integrity
  claim is preserved without retaining personal data.

Alongside it:

- **Retention policies per data class**, declared in configuration and enforced by a
  scheduled job.
- **A data-subject export endpoint** producing everything held about a subject, for the
  access right that accompanies the erasure right.
- **`docs/privacy.md`** describing lawful basis, retention per class, and the erasure
  mechanism in terms a data-protection officer can evaluate.

## Consequences

- Erasure is a single, fast, irreversible operation, and it is *provably* irreversible —
  which is a stronger guarantee than a `DELETE` that a backup silently undoes.
- **Backups are handled correctly, which the naive approach cannot manage.** A
  `DELETE` does not reach a backup taken yesterday; restoring that backup resurrects
  the erased subject. Under crypto-shredding, the backup contains ciphertext whose key
  no longer exists in any live system, so a restore resurrects nothing.
- **Encrypted columns cannot be indexed, searched, sorted or joined.** This is the
  substantial cost and it shapes the schema. Where a lookup on personal data is
  required — logging in by email address — a **blind index** is stored alongside: a
  keyed HMAC of the normalised value under a service-wide index key, which supports
  exact-match lookup and nothing else. The blind index is dropped at erasure along with
  the key. Range queries and partial matches on personal data are not available, and
  the schema is designed around that rather than working around it.
- Key management becomes load-bearing. Losing a key is an unintentional erasure, so
  `data_subject_keys` is backed up on its own schedule and its access is itself
  audited.
- Every read of personal data costs a key fetch and a decryption. Keys are cached per
  request, never across requests.
- Non-personal columns are not encrypted. Deciding which is which is a modelling
  decision made per table and recorded in `docs/privacy.md`; over-classifying makes the
  system unusable and under-classifying defeats the mechanism.
- **This constrains future machine learning.** A model trained on personal data does
  not forget a subject when their key is destroyed, so the erasure guarantee would be
  silently broken by the model's existence. The consequence is recorded in
  `docs/roadmap.md` under "Fine-tuning" rather than discovered afterwards.

## Alternatives considered

**Delete the rows and accept a broken chain.** Rejected: the chain then proves nothing,
and "verification fails here because of a legitimate erasure" is indistinguishable from
"verification fails here because someone tampered".

**Exclude personal data from the audit log entirely.** Rejected: the diff is the
substance of an audit entry. An audit log that cannot say what changed is a timestamp
collection.

**Anonymise in place — overwrite personal fields with tokens.** This is a row
modification, so it breaks the chain exactly as deletion does, and it does not reach
backups.

**Rely on retention expiry alone.** Rejected: erasure is on request, not on schedule.
