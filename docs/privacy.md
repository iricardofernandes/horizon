# Privacy

How Horizon handles personal data: what it holds, on what basis, for how long, and what
happens when someone asks to be erased.

Horizon is designed against **LGPD** (Lei Geral de Proteção de Dados, Brazil) and
**GDPR** (EU). The two are close enough in structure that one design satisfies both; where
they differ, the stricter requirement is applied.

> **Status.** This document describes the design that phases 4 onwards implement. It is
> written now because the erasure mechanism constrains the schema, and retrofitting it
> after tables exist is not possible. Nothing described here is running yet.

---

## Roles

Horizon is software, not a service, so in most deployments:

- The **tenant** is the *controller* — it decides why and how personal data is processed.
- **Horizon** (the operator of a deployment) is the *processor*.

The distinction matters for erasure: a request from a data subject normally reaches the
tenant, which then instructs Horizon. Horizon provides the mechanism and the audit trail;
it does not adjudicate the request.

---

## What personal data is held

| Data | Module | Subject | Why it is held |
|---|---|---|---|
| Name, email address, password hash | `identity/` | User | Authentication and access control — without it, no one can log in |
| Session and API key metadata, IP address, user agent | `identity/` | User | Security: reuse detection, revocation, audit |
| Customer name, `cnpj`/`cpf`, email, phone, address | `sales/` | Customer contact, or a sole trader | Performing the sales contract: a counterparty must be identifiable and reachable |
| Actor identity on every audit entry | all modules | User | Legal obligation and legitimate interest in an accountable record |

Everything else Horizon stores — products, quantities, prices, movements — is **not**
personal data. Over-classification makes the system unusable; the classification is made
per column, at design time, and recorded in the module's schema.

---

## Lawful basis

| Processing | LGPD Art. 7 | GDPR Art. 6 |
|---|---|---|
| Authenticating a user, running the ERP for a tenant | Execution of a contract | 6(1)(b) contract |
| Recording an audit trail of who changed what | Compliance with a legal obligation; legitimate interest | 6(1)(c), 6(1)(f) |
| Security telemetry — IP addresses, failed logins, token reuse | Legitimate interest | 6(1)(f) |
| Retaining fiscal and commercial records after an account closes | Compliance with a legal obligation | 6(1)(c) |

Consent is **not** used as a basis for any of the above, deliberately: consent that can
be withdrawn is the wrong footing for data the system cannot function without, and
presenting it as optional when it is not is worse than not asking.

---

## Retention

Retention is a policy per data class, declared in configuration and enforced by a
scheduled job — not left to whoever remembers.

| Data class | Retained | Then |
|---|---|---|
| Active user account data | While the account exists | Erasable on request |
| Session and refresh-token records | Until expiry, plus a short forensic window | Deleted |
| Security telemetry (IP, user agent, failed attempts) | 12 months | Deleted |
| Customer records tied to commercial transactions | As long as the transactions require | Crypto-shredded when the retention floor passes |
| Audit entries | Retained for the life of the tenant's account | Personal fields crypto-shredded; the chain stays |
| Fiscal and commercial documents | Per Brazilian statutory minima (typically five years) | Reviewed, then shredded |

Erasure and retention pull in opposite directions when a subject asks to be forgotten
while a legal obligation requires the record to survive. Horizon resolves this the way
the law does: the obligation wins for the record's *existence*, and erasure applies to
everything not required to satisfy it. Because personal fields are separately encrypted,
that is a real distinction and not a euphemism.

---

## Erasure — how it actually works

**The problem.** The audit log is append-only and hash-chained per tenant, so that
tampering is detectable by anyone with read access, including an auditor who does not
trust the operator. Deleting a row breaks the chain. Modifying a row breaks the chain.
Erasure requires exactly that. Both requirements are non-negotiable.

**The resolution: crypto-shredding.** Erasure destroys the *key*, not the *row*.

1. Personal data columns are encrypted with a **per-data-subject key**.
2. Keys live in a `data_subject_keys` table (AWS KMS in the Terraform definition).
3. On an erasure request, **the key is destroyed**. The ciphertext remains exactly where
   it was, byte for byte.
4. The hash chain still verifies, because nothing it hashed has changed.
5. The plaintext is unrecoverable — by anyone, including whoever runs the deployment.

What survives is the shape of history: that an entity existed, that an action occurred at
a time, that a record changed. What does not survive is any way to know who it was about.

**Backups are handled correctly, which a `DELETE` cannot manage.** A `DELETE` never reaches
yesterday's backup, so restoring it resurrects the erased subject; a compliant deletion
would require rewriting every backup. Under crypto-shredding, the backup contains
ciphertext whose key exists nowhere in any live system, so a restore resurrects nothing.

**A propagating erasure.** Modules hold their own copies of personal data — `sales/` has
customers, `identity/` has users. `identity/` publishes
`identity.data-subject.erased`, and every module holding data for that subject shreds its
own keys on receipt. The event carries no personal data, only the subject identifier
being destroyed.

### What redaction cannot hide

Sensitive fields are redacted **before** hashing into the audit chain, and **the redaction
list is itself part of the hashed payload**. This is subtle and load-bearing: if the list
sat outside the hash, an attacker could conceal a change by retroactively declaring the
changed field sensitive, and the chain would still verify. Inside the hash, altering what
was redacted breaks the chain exactly as altering the data would.

---

## Data subject rights

| Right | LGPD | GDPR | How Horizon serves it |
|---|---|---|---|
| Access | Art. 18 II | Art. 15 | Export endpoint returning everything held about a subject, across modules |
| Portability | Art. 18 V | Art. 20 | The same export, in a machine-readable format |
| Correction | Art. 18 III | Art. 16 | Normal update paths; the change is audited |
| Erasure | Art. 18 VI | Art. 17 | Crypto-shredding, above |
| Confirmation of processing | Art. 18 I | Art. 15 | The export states which modules hold what |

The export is assembled per module and merged, because there is no cross-module query
(ADR 0016). Each module answers for its own data, which also means each module's answer
is auditable on its own.

---

## Security measures relevant to privacy

- **Isolation.** Row-Level Security, forced, with an application role that cannot bypass
  it. A tenant cannot read another tenant's data even if application code asks
  (ADR 0017).
- **Credentials.** Argon2id at or above the OWASP minimum, rehashed on login when below
  current policy (ADR 0019).
- **Sessions.** Opaque refresh tokens, rotated on every use, with reuse detection that
  destroys the whole family and raises a security audit event (ADR 0020).
- **Telemetry.** Tenant identifiers are hashed before they reach logs or metrics, and PII
  is masked before any payload leaves the MCP debugger — where unmasking is not
  implementable through the API at all (ADRs 0033, 0035).
- **Least privilege.** The debug role holds no privileges on business tables. Migrations
  run under an owner role the application never uses.

---

## Known limitations, stated plainly

- **Encrypted columns cannot be searched.** Exact-match lookup is possible through a blind
  index; ranges and partial matches on personal data are not available. The schema is
  designed around this rather than working around it.
- **Peppering is not implemented.** A pepper would make a database-only breach yield
  uncrackable hashes, and it is declined because rotating one requires plaintexts that do
  not exist. Implementing the storage without a rotation path would be security theatre.
  The reasoning is in ADR 0019.
- **The audit chain proves detection, not prevention.** An operator with database access
  can still delete rows; they cannot do so *undetectably*. Stronger guarantees need an
  external append-only store, which is noted as the future direction in ADR 0025.
- **Model training is constrained and currently forbidden.** A model trained on personal
  data does not forget a subject when their key is destroyed, which would silently break
  the erasure guarantee. See [`roadmap.md`](roadmap.md) under Fine-tuning for the three
  conditions any future training must satisfy first.
