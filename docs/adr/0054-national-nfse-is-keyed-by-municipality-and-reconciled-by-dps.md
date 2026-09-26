# 54. The national NFS-e is keyed by municipality and reconciled by its DPS

- Status: accepted and implemented locally; exercised in simulation
- Date: 2026-09-26

## Context

Phase 47 adds the national NFS-e. It differs from the NF-e family in who decides and what
is sent:
- the taxpayer sends a **DPS** (Declaração de Prestação de Serviço, layout 1.01) to the
  Sefin Nacional, which validates it synchronously and generates the NFS-e;
- the **access key is the authority's**: 50 digits, made by the national system;
- the identifier the taxpayer controls is the DPS identifier: municipality, CNPJ, series
  and number (Anexo I, E0004).

Anexo I also fixes three rules that shape this design:
- a DPS already turned into an NFS-e is refused when sent again (E0014);
- the municipality decides whether the national system issues at all: it needs an active
  agreement and the national public issuer, from a start date (E0016, E0037–E0039);
- a provider outside the Simples Nacional in an active municipality does not state the
  ISS rate: the municipal parameter applies (E0617).

Most municipalities have an agreement, but many issue in their own systems and only
share with the national environment. The official list of 2026-09-18 shows this for
Campinas: agreement active, national issuer "Não".

Horizon has no service order or recurring contract yet (Phase K). The Catalog classifies
goods only.

## Decision

- **Same lifecycle, own model.** The NFS-e is a `fiscal_documents` row of model `nfse`.
  It reuses the states, number reservations, the calculation lock, the dispatch queue,
  the outbox and the artifacts. Everything model-specific lives in `fiscal/src/nfse/`.
- **A service origin with a competence date.** `POST /fiscal/service-origins` freezes
  the provision (encrypted, digest):
  - establishment, issuer and recipient revisions, the service item and the service
    profile revision in force;
  - the competence date, the amount and a description.

  An optional **source key** (module, document type, id, period) is unique per tenant.
  Replayed owner facts return the same origin; different facts under the same key are
  refused (`SOURCE_KEY_CONFLICT`). Phase K contract periods will arrive through it.
- **A service fiscal profile.** Fiscal keeps revisioned, effective-dated profiles per
  Catalog service item: national tax code, NBS and ISS treatment, checked against the
  pinned national lists (Anexo B). The goods classification is untouched.
- **The municipality decides, through a versioned registry.** A reviewed import of the
  official adhesion list says, per IBGE municipality, whether the agreement is active,
  whether it uses the national issuer and from when. Resolution uses the latest reviewed
  version:
  - `national` only for an active agreement with the national issuer, on or after its
    start date;
  - `unsupported` otherwise, including an absent municipality or an unreviewed version.

  The capability row is keyed by municipality. An unsupported municipality is refused
  when the origin is frozen, at readiness, at issuance and by the simulated authority, so
  it never reaches the transmission boundary.
- **The DPS identifier is bound before sending, the key after.** The issuance binding
  holds the DPS identifier. `fiscal_nfse_generations` holds what the authority
  generated: key, NFS-e number, `dhProc` and XML digest. It is written in the same
  transaction that authorizes the document, and an authorized NFS-e without it is refused
  by the status guard.
- **A lost response is found by DPS.** After an uncertain first send, the worker asks
  `GET /dps/{id}` (and then the NFS-e by key) before any resend. Only a DPS the national
  system never received is sent again.
- **The ISS rate is not stated.** The DPS omits `pAliq`, as E0617 requires. The
  calculation locks ISS at the reviewed municipal parameter and CBS/IBS at the reference
  rates. The generated NFS-e values are reconciled with it (`calculation_matches`).
- **Events.**
  - Cancellation is event 101101, allowed inside the municipal window counted from
    `dhProc`.
  - Substitution is a new DPS with `subst`. When the national system generates it, it
    registers event 105102 on the original, which becomes `cancelled` in the same
    transaction.
  - The recipient, competence, service code and place of provision cannot change
    (E0058, E0060). An original has at most one live substitute and cannot be cancelled
    while one is pending.
- **Outcome event.** `fiscal.service-document.simulation-outcome` names the service
  origin, its source key, municipality and competence, and a substitution link. It
  carries no access key, recipient data or XML and names no stock or money owner.

## Consequences

- The official XSD 1.01 has a defect: the `TSSerieDPS` pattern uses anchors that are
  literal characters in XSD regular expressions. Horizon validates with those two
  characters removed, only after the package digest matched, and a test pins the exact
  replacement.
- Restricted production and production need:
  - an establishment's ICP-Brasil A1, since the Swagger contract and the municipal
    parameters are retrievable only with it;
  - the confirmed XML-DSig algorithms (the simulation uses RSA-SHA256);
  - an HTTP adapter for the Sefin Nacional;
  - their own capability rows and evidence.
- A municipality with its own issuing system needs its own adapter, fixtures and support
  row. The registry never turns an adhesion statistic into support.
- The DANFSe is the national system's (`/danfse`); Horizon does not render one.
- Simples Nacional and MEI providers, withholding, deductions, benefits, exports,
  tomador or intermediary issuance and the manifestation and fiscal-analysis events
  stay unsupported.
