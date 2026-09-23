# Phase 43 — NF-e model 55 homologation for one issuer and UF

Status: **planned; no homologation credential or issuer tuple is recorded as configured**.
Official portal reconnaissance was checked on 2026-09-23; recheck versions and
endpoints before implementation. This is the
execution plan for [Phase 43](fiscal-implementation-plan.md#43--one-nf-e-sefaz-homologation-path).
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

The current Sales flow dispatches first and creates the fiscal origin in that same
transition. Refactor the eligible path to:

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
