# Fiscal threat model

Scope: the `fiscal/` module, its screens in `web/`, its events and its artifact store,
as delivered through Phase 48. The environment is simulation-only: no authority is
contacted and no document has fiscal value. Each row names the control and the test or
evidence that proves it. A threat without a test is listed as open.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Establishment A1 certificate and private key | `fiscal_establishment_credentials`, encrypted with `FISCAL_ARTIFACT_KEY_HEX` | It signs documents in the company's name |
| Signed XML, protocols, DANFE, NFS-e XML, events | Object store, AES-GCM per object key; digest in the database | Legal evidence; must stay unaltered and retained |
| Supplier XML | Object store and `fiscal_inbound_documents` | Evidence of what a supplier declared |
| Origin snapshots (party, address, lines) | `fiscal_documents.snapshot_ciphertext` and origin tables, encrypted | Personal and commercial data (LGPD) |
| Tax rules and source packages | `fiscal_tax_rules`, `fiscal_source_packages`, payloads | A changed rule changes every later tax result |
| Authority outcome and queue | Dispatch commands, jobs and observations | A wrong reading issues twice or loses a document |
| Outbox events | `fiscal_outbox`, `fiscal_outbox_replays` | Other modules act on them |

## Trust boundaries

1. **Browser → web → Kong → Fiscal.**
   - Users carry a session cookie. The web proxy forwards a short EdDSA token.
   - Fiscal verifies the signature, issuer, age and revocation (Redis denylist), and
     reads the `fiscal` role.
2. **Fiscal → owner modules.** Parties, Identity and Catalog are called with a
   tenant-scoped service key and restricted projections (ADR 0049).
3. **Fiscal → authority.** Today only deterministic simulators and the emulated SEFAZ.
   Homologation over mutual TLS with a pinned trust anchor exists for the Phase 43 drill
   only.
4. **Fiscal → object store and database.**
   - The database has one role per module, and RLS is forced on every business table.
   - Objects are encrypted before they leave the process.
5. **Fiscal → broker.** It publishes events with confirms and consumes owner events
   through an inbox.
6. **Operator → support CLI.** Runs inside the Fiscal container with its database
   credentials.

## Threats and controls

| Threat | Control | Proof |
|---|---|---|
| A tenant reads another tenant's documents, artifacts or support data | RLS forced on every table, including `fiscal_outbox_replays`; tenant from the verified token only; the worklist and overview filter by tenant | e2e `forces tenant RLS on every Fiscal business table`; worklist cross-tenant e2e; restore drill: another tenant gets 404 |
| A role does more than it may | Permission per route (`read`, `draft:create`, `transmission:submit`, `cancellation:request`, `import:review`, `credentials:manage`); the screens hide what a role cannot do, and the server still refuses | `auth.spec.ts`, route specs, `allowedActions` spec |
| A simulated document is taken as valid | Every read carries `simulated` and `fiscalValue: false`; the screens label it "Simulação — sem valor fiscal"; XML uses `tpAmb` 2 | Contract specs; `types.spec.ts`; browser workflow (pt-BR and en) |
| A lost authority response causes a second document | Consultation by key or DPS before any resend; final observation unique per command | Phase 42, 46 and 47 e2e; support `reconcile-unknown` e2e (1 send, 1 consultation) |
| A support command duplicates an effect | Bounded commands over idempotent paths; replay under the same event id; consumers deduplicate; audit per command | e2e: retry, reconcile, replay once through RabbitMQ; golden path: replay leaves stock and receivables unchanged |
| Tampering with stored evidence | Append-only triggers on documents' evidence, outbox and replays; digest checked on every artifact read; AES-GCM bound to the object key | Immutability e2e; restore drill (75 artifacts by SHA-256) |
| Certificate or key leak | PFX password never stored; PEM encrypted at rest; key in a secret, never in logs or events; metrics without identifiers | Credential specs; ADR 0055 label rules |
| Personal data in logs, metrics or events | Events carry ids and digests, not tax ids or addresses; metric labels bounded; worker logs only error types | Contract specs (no access key or party in support reads); `rejectionLabel` spec |
| Malicious supplier XML (XXE, bombs, oversized) | Size limit, forbidden declarations, pinned XSD, signature check before storing | Phase 44 inbound specs |
| A tax rule or source changes silently | Source packages by digest; rules versioned and effective-dated; reviewed activation; explanation cites rule and source | Phase 41 rules e2e; source age alert |
| An unsupported jurisdiction is advertised | Capabilities default to unsupported; NFS-e registry per municipality; support matrix lists only activated rows | Phase 47 e2e (Campinas never reaches the simulator); browser check of the registry answer |
| The support read is used for reconnaissance | Counts and ages only; `read` permission and tenant scope; `private, no-store` | Route spec (400 on unknown query fields, 401 without token) |
| Denial of service by listing | Keyset pagination, limit at most 100, indexes on the worklist and outbox | Route spec (limit 101 refused) |

## Open items

- **Authority boundary in production.** Mutual TLS with the company A1, the official
  WSDL and Swagger, and signature algorithm confirmation remain gated, as in Phases
  43–47.
- **Web session hardening.** CSRF and the content security policy follow the web
  platform's existing controls and are not specific to Fiscal. No Fiscal-specific review
  was done in this phase.
- **Backup encryption and key custody.** These belong to the deployment owner
  ([runbook](fiscal-operations-runbook.md#backups)).
- **Alert delivery.** Prometheus evaluates the rules, but no alert channel is configured
  locally.
