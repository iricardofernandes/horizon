# Phase 43 — NF-e model 55 homologation for one issuer and UF

Status: **in progress; no homologation credential or issuer tuple is recorded as configured**.
Official portal reconnaissance was checked on 2026-09-23; recheck versions and
endpoints before implementation. This is the
execution plan for [Phase 43](fiscal-implementation-plan.md#43--one-nf-e-sefaz-homologation-path).
The [candidate source manifest](fiscal-phase43-source-manifest.json) records exact
retained hashes and the decisions still pending independent review.
`GET /fiscal/capabilities/v2` exposes activated simulation and homologation rows with
`fiscalValue: false`; the version 1 route and schema remain simulation-only. Neither
read route grants document creation or transmission.
Phase 42 completed one local model-55 simulation tuple. Phase 43 proves a separate,
real NF-e 4.00 homologation path against the official authorizer and prepares the
operational dispatch gate. It does not activate production transmission.

## Outcome and scope

An eligible tenant can freeze one Sales shipment before dispatch, produce its fiscal
draft, issue it through a real SEFAZ homologation endpoint, consult an uncertain
outcome, and submit a supported cancellation event. The exact issuer establishment,
UF, normal-sale operation, authorizer, schema release, adapter version and source
package are recorded in a capability row and evidence packet. Every response and
artifact says `homologation` and **has no fiscal value**. An authorization in this
environment must never dispatch stock or create a receivable.

SP is the first **candidate** because the Phase 42 calculation scenario is intrastate
SP and the [national NF-e homologation service list](https://hom.nfe.fazenda.gov.br/portal/webServices.aspx?tipoConteudo=VjrjMInPXGA%3D)
lists SP's version 4.00 authorization, receipt, protocol consultation, service status
and event endpoints. The candidate is not an approved tuple. Choose an actual issuer,
confirm its SP NF-e credentialing and certificate, and verify the effective technical
rules before freezing the tuple. The Phase 42 alphanumeric example issuer and
simulation credential cannot stand in for that issuer. The
[SEFAZ-SP credentialing guide](https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/PaginaGuiaDoUsuario.aspx)
describes its ICP-Brasil certificate requirement; the
[MOC 7.0 overview](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=LrBx7WT9PuA%3D)
states that use of an environment depends on the UF's credentialing process.

This phase covers model 55, one normal intrastate sale, authorization, receipt and
protocol consultation, service status, and normal cancellation event `110111`. It
does not add NFC-e, NFS-e, contingency, number invalidation, returns, production
transmission, or a generic nationwide adapter. A business rejection is retained as
a final authority observation; an outage or ambiguous result stays unresolved until
consultation or operator reconciliation.

## Starting point and gaps

| Boundary | Phase 42 state | Phase 43 change |
|---|---|---|
| Fiscal capability | Definitions admit `homologation` and `production`, but activation, active reads and the public API expose only `simulated`. | Add separately reviewed `homologated` activation and read model. Keep production activation disabled. |
| Issuance and worker | `FiscalIssuance` requires `environment=simulation`; `FiscalIssueWorker` calls `DeterministicNfe55Simulator` and stores JSON simulator outcomes. | Select a versioned adapter by exact capability; persist and validate real SOAP/XML request, response and protocol bytes. |
| Recovery | The simulator may resubmit after one `not_found` consultation. | Treat uncertain network and receipt results conservatively; never infer safe resend from one empty consultation. |
| Certificate | A local simulation key and certificate are read from files. | Add a secret-provider boundary for issuer-controlled ICP-Brasil signing and mutual TLS, with expiry, identity and rotation checks. |
| Sales dispatch | `sales.fiscal-origin.recorded` is emitted when the shipment is already dispatched. | Freeze the fiscal origin while packed and block dispatch for the selected policy until a **production** authorization is confirmed. Homologation cannot clear the gate. |
| Rendering/events | DANFE and status events are explicitly simulated. | Preserve environment-specific labels and event types; prevent homologation artifacts or events from being read as production authorization. |

Do not convert the Phase 42 simulation row into a homologation row. The two capabilities
and their source, profile, number sequence, credentials and evidence remain distinct.

## Work packages and gates

| Step | Deliverable | Exit gate |
|---|---|---|
| 43.1 Tuple and source freeze | Confirm the legal issuer, tenant, establishment, SP credentialing, recipient/test transaction, certificate custody, authorizer, current MOC/NT/XSD/WSDL and calculation package. Add `fiscal-phase43-source-manifest.json` with downloaded byte hashes and reviewer decisions. | An independent Fiscal reviewer approves the exact tuple and source interpretation. Missing issuer access leaves this step pending without enabling transmission. |
| 43.2 Capability and contracts | Add append-only `homologated` review/activation evidence and environment-aware read models/contracts. Recheck exact consumer pins and backward compatibility. | Database and API reject activation without the tuple, reviewer, source digest, certificate identity, adapter version and executable evidence. `production-enabled` remains unavailable. |
| 43.3 Credential and endpoint boundary | Load certificate/key through a secret reference, verify issuer identity, validity period and matching key, configure mutual TLS and an allowlisted homologation endpoint set. | A test credential exercises TLS locally; the real credential never enters Git, DB, API bodies, logs, traces or CI artifacts. Rotation and expiry failure close the route. |
| 43.4 SOAP adapter | Implement versioned NF-e 4.00 authorization, receipt consultation, protocol consultation, status and `110111` event exchange behind an authority port. Validate the outbound XML and inbound SOAP/body against pinned schemas and bound size limits. | Offline fixtures cover valid and malformed envelopes, namespace/version mismatch, bad signature, wrong environment, wrong issuer/key, and unexpected status codes. |
| 43.5 Durable authority orchestration | Route queued commands by persisted capability and adapter version. Store exact request/response/protocol bytes and digests, transport attempt, endpoint identity, receipt/protocol numbers, timestamps and structured `cStat` observations. | Crash, duplicate command, concurrent worker, lost response, polling, and delayed result tests retain one number and one final outcome; an uncertain document is never blindly resubmitted. |
| 43.6 Sales pre-dispatch gate | Move the immutable Sales fiscal origin to the packed/pre-dispatch boundary. Give Fiscal one idempotent origin per shipment. Persist a tenant-scoped release projection from versioned **production** authorization events, then check it transactionally in every dispatch path. | A simulated or homologated status, missing status, rejected/cancelled document, stale revision, duplicate event or unavailable projection cannot dispatch; only an exact production authorization may release the configured shipment. Existing unrelated flows retain their declared policy. |
| 43.7 Homologation run | With the owner's issuer credential, run authorization, business rejection, temporary outage, lost response and consultation, then normal cancellation for the exact tuple. Reconcile each result with the official portal. | Redacted evidence contains timestamps, endpoint and source versions, request/response digests, receipt/protocol references, status history and test operator signoff. No raw protected XML or private key is committed. |
| 43.8 Rollout and recovery | Publish the scoped support matrix, configuration/runbook, alert and rollback procedure. Restore database and artifacts; disable the homologation capability and prove pending commands drain safely. | Local/CI gates pass, restored bytes match, other tenants and tuples remain blocked, and production transmission remains off. |

Steps 43.1 and 43.2 can begin without a certificate. Offline adapter fixtures and
transport code may follow a pinned source set. Real SEFAZ calls require the tuple,
credential, endpoint review and security gate. Run the first live cases through a
time-limited, audited internal homologation drill command bound to that exact tuple,
not through public issuance or a prematurely active capability. Activate
`homologated` only after the 43.7 evidence exists.

## Source and protocol decisions to freeze

Revisit the [Fiscal source register](fiscal-source-register.md) and
[Phase 42 source review](fiscal-phase42-source-review.md) on the implementation date.
Pin the exact MOC, effective technical notes and the consumed document, event and
response XSD files by SHA-256. The provisional PL 010f/PL 010d combination was
accepted for **simulation only**; the homologation reviewer must resolve the
cancellation-specific `detEvento` validation and any newer package before use.
Document the NF-e 4.00 WSDL/service operations and endpoint URLs from the
[official homologation service list](https://hom.nfe.fazenda.gov.br/portal/webServices.aspx?tipoConteudo=VjrjMInPXGA%3D).
Pin the service list retrieval time and do not synthesize URLs or fall back to a
production host. Review SOAP version, headers, encoding, request limits, receipt
polling and response schemas from the selected official package before coding them.

The adapter must distinguish transport failure, SOAP fault, batch receipt, batch
processing, document authorization, business rejection and event registration. An
HTTP success does not establish fiscal authorization. The
[MOC 7.0 Annex I](https://hom.nfe.fazenda.gov.br/PORTAL/exibirArquivo.aspx?conteudo=DQFCIFUzszw%3D)
lists, among others, `100` for document authorization, `103` for received batch,
`104`/`105` for processed/in-process batch, and `135` for an event registered and
linked to the NF-e. The selected release must supply the exact decision table,
including less common statuses and event outcomes. An unknown code is retained as
`unknown` for review, never mapped optimistically to authorization or rejection.
For cancellation, verify event code, access key, protocol number, issuer and the
response's link to the original document; the
[MOC 7.0 cancellation section](https://hom.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?AspxAutoDetectCookieSupport=1&conteudo=BSUCYHAKYUk%3D)
specifies event `110111` and issuer signing.

## Persistence, routing and security rules

Use forward migrations only. Keep the existing simulation rows immutable. A document
binds one environment, issuer, adapter version, schema/source digest, signing
certificate fingerprint, endpoint set and original signed XML before queuing. Do not
change those fields when a credential rotates; new commands use a new binding.
Number counters and access keys remain isolated by environment. Add protocol and
receipt fields or typed immutable observations as needed, retaining the exact bytes
in encrypted object storage and only digests/references in ordinary events.

The worker chooses its adapter from the persisted capability, not a request body or
mutable process default. Only the reviewed homologation host is reachable from the
homologation adapter. Disable redirects, cap response bytes and time, verify the TLS
peer, and use a bounded per-service concurrency and circuit-breaker policy. Define a
specific retry budget for **consultation**; an ambiguous submit or cancellation
response becomes `unknown`. A `not_found` query is not proof that the prior request
was never accepted. Preserve the reserved number and signed bytes, repeat bounded
consultation under the documented authority timing policy, then stop for operator
reconciliation if uncertainty remains. A new submission needs explicit evidence that
the first one was not processed and must reuse the same immutable identity.

Never write credential material or unrestricted fiscal XML to logs or telemetry.
Audit every capability change and manual reconciliation with actor and reason.
Publish environment-tagged status events only after the local transaction commits.
The public API and artifact downloads must label homologation documents **without
fiscal value**; a rendered homologation DANFE must carry an unmistakable watermark.
The [SEFAZ-SP FAQ](https://portal.fazenda.sp.gov.br/servicos/nfe/Paginas/perguntas-frequentes.aspx)
states that homologation NF-e has no legal validity.

## Sales sequencing and operational ownership

The legacy Sales flow dispatches first and creates the fiscal origin in that same
transition. Refactor the eligible path to:

Implementation note: the scoped Sales policy now emits `sales.fiscal-origin.recorded`
version 2 at packing and stores its canonical payload digest with the shipment,
order version, warehouse and establishment. Fiscal ingests that version separately
from the legacy dispatch-time version 1. Sales now has an idempotent production
outcome consumer that checks the packed shipment, tenant policy and exact frozen
origin before inserting an append-only observation in the inbox transaction.
Dispatch gives newer document revisions priority and refuses a revision with a
rejection or cancellation. The production outcome subscription stays disabled in
the Sales runtime for phase 43; there is no Fiscal production publisher. The live
homologation path remains pending, and configured shipments stay blocked.

Fiscal can now read a version 2 pre-dispatch origin and create one internal
homologation draft from it, bound to the origin's establishment and encrypted
snapshot. The public create route and readiness/issuance paths still require
simulation; this draft cannot be transmitted through them. The reviewed issuer
tuple, capability evidence and live authority orchestration are still required.

The homologation SOAP adapter now exposes a prepared, validated envelope and a
separate correlated response parser. The durable worker must persist the exact
prepared bytes before marking transmission started; after an ambiguous send it
must consult the authority instead of resubmitting that envelope.
The response parser now also binds the SOAP wrapper to the prepared operation,
requires one result payload and the expected service version, and rejects duplicate
status fields. The durable exchange runner now validates the extracted payload
against byte-pinned official return XSDs after retaining the raw SOAP bytes and
before recording parsed authority facts. The candidate set uses PL 009p v1.03 for
authorization/status and PL 010d v1.03 for receipt/protocol/event; its exact
combination and effective dates still need independent Fiscal review before live use.
The SOAP adapter only prepares and parses; network transmission is available through
the guarded exchange runner, which requires the response validator.

An internal exchange ledger now persists the request artifact, one send marker,
the raw response artifact and its parsed `cStat`/receipt/protocol facts. A
time-limited drill grant requires an independently reviewed SP homologation
capability and binds document, endpoint, WSDL, certificate and adapter digests.
The runner records the raw response before parsing and refuses a second send
after a send marker, including when the first response was lost. This ledger is
not yet wired to the Fiscal issue worker or a live SEFAZ credential.

The database now permits only one prepared authorization and one cancellation
event per document. A receipt or protocol consultation must reference the
started authorization, retain its access key and, for a receipt query, use the
receipt actually recorded in the parent response. Recovery chooses protocol
consultation after a lost response and receipt consultation when a receipt was
recorded; it never starts another authorization for the same document.
Cancellation preparation now extracts the authorization `nProt` from the signed
event, and the database requires an observed `cStat=100` authorization with that
exact protocol before accepting the event exchange. A merely started authorization
or a different protocol cannot permit cancellation.
Parsed responses now retain a versioned, immutable homologation decision alongside
their SEFAZ codes. Only a complete `100` authorization protocol is classified as
authorized; `103` with receipt and `105` remain pending, while duplicate, missing
and unreviewed codes remain unknown. Event cancellation requires `128` and nested
`135` with a protocol. The database checks the evidence for every non-unknown
decision. These observations do not change the fiscal document lifecycle or
release a shipment. The status combinations follow the
[official MOC 7.0 annex](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=J+I+v4eN00E%3D).
The `homologated` activation gate now also requires the reviewer evidence to name
one started authorization, its authorized receipt/protocol consultation, and the
cancelled event for the same document, access key, protocol, grant and capability.
An arbitrary evidence digest or an unlinked exchange cannot activate the tuple.
This structural check does not replace the independent comparison with the
official portal and the live evidence record.
After the live review is complete, register its evidence with
`npm run phase43:activation -- --action evidence --file <json>` in `fiscal`.
The JSON includes the capability and source/endpoint/certificate digests,
`roundTripDigest`, the three exchange IDs, `reviewedBy` and `reviewedAt`.
Use `--action activate` with a separate file containing `tenantId`, `capabilityId`,
`evidenceDigest` equal to the reviewed round-trip digest, `actorId`, `reason` and
`occurredAt`. The same command supports `--action deactivate` during rollback.
An operator can inspect the tenant-scoped exchange history with
`npm run phase43:observations -- --tenant <uuid> --document <uuid>` in `fiscal`
after building the package. It shows prepared, send-started, raw-unparsed and
observed stages with digests and decisions, without decrypting XML or credentials.
Recovery consultation now stops once the ledger contains an authorized, rejected
or cancelled decision for the document.
The database also caps receipt and protocol consultations at ten prepared exchanges
per document, including attempts that never reached the network. Exhaustion requires
manual reconciliation; it cannot cause a new authorization send.
The terminal decision and consultation send marker share a document-scoped database
lock, so a prepared consultation cannot start after a final result was recorded.
Homologation number reservations now require an immutable, independently reviewed
range for the exact SP establishment and series, plus a live drill grant. The
first number comes from that range; the counter and reservation remain separate
from simulation. Register a reviewed range with
`npm run phase43:number-range -- --file <json>` in `fiscal` after building it.
The JSON requires `tenantId`, `capabilityId`, `establishmentId`, `series`,
`firstNumber`, `lastNumber`, `evidenceDigest`, and `reviewedBy`. The evidence must
establish the issuer's available homologation numbering before live issuance;
no default number is assumed.
Authorization preparation now requires one immutable binding among the signed
NF-e bytes, exact SOAP envelope, access key, reserved number, schema package and
drill grant. The adapter validates the signed document before the ledger binds it;
the database rejects a different envelope or an access key with another series or
number. The internal preparation command described below is available; the
production worker remains outside this phase's activation.
For homologation, a separate approval now binds the capability's source manifest
and fixture to the exact reviewed calculation package digests. Each package must
have retained bytes and an independent review by the same Fiscal reviewer. The
database refuses a draft-to-ready transition if the calculation used another
package set. The internal readiness command is available, but a real reviewed
rule package is still required before this gate can be exercised for issuance.
The reviewer registers that exact package set with
`npm run phase43:calculation-approval -- --file <json>` in `fiscal` after building.
The JSON requires `tenantId`, `capabilityId`, `sourceManifestDigest`,
`calculationFixtureId`, sorted `packageDigests`, and `reviewedBy`.
The issuer address and each commercial line's NF-e product mapping now have a
separate immutable homologation profile, bound to the same reviewed capability
and source manifest. Register it with
`npm run phase43:issuance-profile -- --file <json>` in `fiscal` after building.
The JSON requires `tenantId`, `capabilityId`, `sourceManifestDigest`, `reviewedBy`,
and `profile`. The profile contains `capabilityId`, `issuerAddress` and `lineFacts`
as defined by the NF-e issuance profile schema. The reviewer must match the
approved capability review and differ from its creator. No simulation profile is
used to supply homologation CFOP, product codes or issuer address.
An internal issuance preparation service now reads the ready document, frozen
calculation and historical projections, verifies the reviewed profile and live
drill against the mounted signing credential, then reserves a number and binds
the signed NF-e and SOAP envelope to one exchange. It records the prepared
exchange without sending it. An integrated test with real reviewed issuer facts
and rule packages is still pending.
Run `npm run phase43:issuance-prep -- --tenant <uuid> --document <uuid>
--grant <uuid> --exchange <uuid> --actor <id> --certificate <pem>
--private-key <pem> --certificate-fingerprint <sha256> --issuer-tax-id <cnpj>
--schema <zip> --operations <json>` in `fiscal` after building. It also requires
`DATABASE_URL`, `FISCAL_ARTIFACT_KEY_HEX`, `FISCAL_ARTIFACT_BUCKET`, and
`FISCAL_ARTIFACT_REGION`; `FISCAL_ARTIFACT_ENDPOINT` is optional. The operations
file supplies the five reviewed SOAP operation names/namespaces and WSDL digest.
The command checks these against the active drill, stores only encrypted request
artifacts, and reports `sent: false`. Reuse the same exchange ID for a retry.
The cancellation event XSD archive has a separate immutable reviewer approval.
Register its digest with `npm run phase43:event-schema-approval -- --file <json>`;
the JSON requires `tenantId`, `capabilityId`, `sourceManifestDigest`,
`schemaDigest`, and `reviewedBy`. Approval must refer to the same capability
reviewer and source manifest, and the schema bytes supplied at cancellation must
match this digest. The exact archive must first be retained as a Fiscal source
payload and independently reviewed as a source package; approval recomputes its
SHA-256 from those retained bytes.
Once an authorized protocol is observed, prepare a signed cancellation with
`npm run phase43:cancellation-prep -- --tenant <uuid> --document <uuid>
--exchange <uuid> --actor <id> --reason <15-255 chars>
--occurred-at <local ISO timestamp> --certificate <pem> --private-key <pem>
--certificate-fingerprint <sha256> --issuer-tax-id <cnpj>
--event-schema <zip> --operations <json>`.
It uses the same database and artifact-store environment variables as issuance
preparation. The command selects the exact authorized protocol from immutable
SEFAZ observations, checks the reviewed event archive, signs and stores the event,
and reports `sent: false`. Use `phase43:exchange-resume` with the same exchange ID
to transmit it. Repeating preparation with the same ID and timestamp is idempotent;
a different cancellation event for the document is rejected.
If a process saved the raw SOAP response but stopped before parsing it, run
`npm run phase43:reparse -- --tenant <uuid> --exchange <uuid> --actor <id>
--operations <json> --document-response-schema <zip>
--consultation-response-schema <zip>`. It requires the database and artifact-store
environment variables, but no signing certificate or SEFAZ network access.
It only accepts an exchange in the `raw_unparsed` state, validates the stored
response against the pinned operation and schema, and records the parsed facts.
The prepared exchange can then be resumed with
`npm run phase43:exchange-resume -- --tenant <uuid> --exchange <uuid> --actor <id>
--worker <id> --certificate <pem> --private-key <pem>
--certificate-fingerprint <sha256> --issuer-tax-id <cnpj>
--trust-anchor <pem> --trust-anchor-fingerprint <sha256>
--operations <json> --endpoints <json>
--document-response-schema <zip> --consultation-response-schema <zip>`.
It uses the same database and artifact-store environment variables as preparation.
The command loads the exact stored SOAP request and sends it only if no transmission
marker exists. A stored raw response is parsed without another send. A started
exchange without a raw response remains uncertain and requires consultation;
repeating this command cannot submit it again. The endpoint file must contain the
five reviewed SP homologation URLs, and its digest must match the drill grant.
For an authorization whose send marker exists but whose outcome is unresolved,
`npm run phase43:consult -- --tenant <uuid> --document <uuid>
--exchange <new-uuid> --actor <id> --worker <id>` accepts the same certificate,
trust anchor, operations, endpoints and response-schema flags as `exchange-resume`.
It selects receipt or protocol consultation from the stored authorization evidence,
persists the new request under the supplied exchange ID, and obeys the ten-attempt
consultation budget. A pending result remains pending; the command never retries
the original authorization.
An operator can check service availability with
`npm run phase43:status -- --tenant <uuid> --document <uuid>
--grant <uuid> --exchange <uuid> --actor <id> --worker <id>` and the same
credential, trust anchor, operations, endpoints and response-schema flags as
`exchange-resume`. This creates an auditable status exchange under the active
drill, validates its response, and never changes the document's authority status.
After restoring the database and encrypted object store into an isolated
environment, run `npm run phase43:restore-verify -- --tenant <uuid>
--document <uuid>` for each drill document. It requires the same database and
artifact-store environment variables as issuance preparation. The verifier reads
every stored SOAP request, raw response, protocol and signed NF-e referenced by
the ledger, checks each artifact's digest and purpose, and fails if any bytes are
missing or altered. It does not transmit to SEFAZ. A successful verifier run is
only one part of the restore gate; the actual restored deployment must also prove
its pending-exchange recovery and capability deactivation.
An internal readiness path now derives the homologation calculation from the frozen
origin and historical projections only when the drill is active and the reviewed
calculation approval exists. It refuses a changed rule result between preview and
binding; the public readiness route remains simulation scoped. A reviewed live
rule package is still needed to use this path on the issuer.
Once the reviewed rules and tenant projections are present, run
`npm run phase43:readiness -- --tenant <uuid> --document <uuid> --grant <uuid> --actor <id>`
in `fiscal` after building. It requires `DATABASE_URL` and
`FISCAL_ARTIFACT_KEY_HEX`, returns only decision codes and digests, and exits with
code 2 for an unsupported calculation. It does not submit to SEFAZ.

The secret-mounted certificate loader now requires the issuer's exact CNPJ in
the ICP-Brasil legal-entity `otherName` OID `2.16.76.1.3.3`, following the
[ITI OID assignment](https://www.gov.br/iti/pt-br/assuntos/legislacao/documentos-principais/copy_of_IN152020DOC04.01comanexo.pdf).
The adapter also checks the access key's issuer against that certificate identity
before preparing authorization, consultation or cancellation. Certificate chain,
revocation and SEFAZ credentialing evidence still require review for the real issuer.
The exchange runner now compares each grant's endpoint, certificate and WSDL
digests with its actual transport and adapter before persisting or sending a request;
the transport computes its endpoint digest from the five validated SP URLs.
The transport now requires a separate, fingerprint-pinned ICP-Brasil TLS root
certificate from a mounted path and keeps peer and hostname verification enabled.
It now bounds concurrent sends per service and opens a short local circuit after
repeated transport failures; neither case retries a submission automatically.
The [ITI root repository](https://www.gov.br/iti/pt-br/assuntos/repositorio/repositorio-ac-raiz)
lists the v10 SSL root; the exact root bytes and current SEFAZ server chain need
independent review. On 2026-09-23, direct WSDL retrieval without a configured root
failed chain validation, and an untrusted diagnostic request received HTTP 403.
No WSDL has been approved or pinned from that attempt.

`GET /fiscal/documents/:id/v2` and
`GET /fiscal/documents/:id/artifacts/v2` now carry the environment and
`fiscalValue: false`. Homologation request, response and protocol artifacts
have explicit purposes; their v2 downloads require an issuer, reviewer or admin
role and use a `homologacao-sem-valor-fiscal` filename. The version 1 document
and artifact routes remain simulation-only. These additions are pinned in
`@horizon/contracts@0.31.0`.

1. pack shipment and freeze the commercial lines, recipient, issuer, quantities,
   prices and revision into an idempotent `sales.fiscal-origin.recorded` event;
2. have Fiscal ingest that origin, validate and issue the exact document;
3. maintain an idempotent Sales release projection keyed by tenant, shipment, fiscal
   origin, document revision, environment and final authority status;
4. check that projection inside the Sales dispatch transaction before emitting
   `sales.shipment.dispatched`, Inventory movement or Financial receivable facts.

For the homologation tuple, step 4 deliberately refuses dispatch. Production release
is a separate future capability gate, requiring production evidence and an explicit
operator decision. Simulated and homologated events never satisfy it. If a shipment
changes after its origin is frozen, invalidate the release and require a new reviewed
origin/revision; do not attach an authorization for old quantities or amounts to the
new shipment. The gate must cover direct API, retries, worker paths and concurrent
requests. Fiscal reports status; Sales owns the dispatch decision, Inventory owns stock
movement, and Financial owns the title.

## Verification matrix

| Layer | Required cases |
|---|---|
| Pure parser/serializer | Golden request/response bytes and schema validation; authorization, receipt pending, rejection, fault, malformed XML, wrong key/issuer/environment, oversized payload, event accept/reject. |
| Adapter with local TLS server | Correct certificate and host, expired/mismatched credential, trust failure, connection reset before/after send, timeout, 5xx, SOAP fault, redirect refusal, circuit breaker and bounded retry. |
| PostgreSQL/worker | Forced RLS, idempotent command, number collision, concurrent claims, lease recovery, repeated consultation, duplicate/conflicting authority response, immutable artifacts, outbox delivery and rollback. |
| Cross-module | Packed shipment creates one origin; wrong or duplicated status cannot clear the gate; homologation cannot dispatch; production release predicate is exact; unchanged legacy path remains covered. |
| Live homologation | Official authorization, rejection, outage/unknown reconciliation, status lookup and cancellation for the selected issuer/SP tuple; source and endpoint version recorded. |
| Restore | Clean PostgreSQL and object-store restore, digest and tenant checks, pending-command recovery, capability deactivation and zero production side effects. |

CI must run offline fixtures and local fault injection without a live credential.
The live homologation suite is a separate, explicitly configured job against the
selected issuer and official endpoint. Record its result and reviewer in
`docs/fiscal-phase43-evidence.md`; no test should claim success by using the simulator
as the real adapter. Keep the Phase 42 simulation and the repository golden path green.

## Completion and handoff

Phase 43 is complete only when the exact issuer/SP homologation capability has a
reviewed source manifest, passing offline and live suites, a verified official
round trip, consultation and cancellation evidence, clean restore, and an
operator-visible support row. The pre-dispatch gate must reject all simulation and
homologation results and prevent stock or money effects for the tested shipment.
Production transmission stays disabled. The later production decision needs its own
credential, tuple evidence, operational runbook and explicit activation record; no
homologation result is promoted automatically.
