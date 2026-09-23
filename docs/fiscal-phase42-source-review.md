# Phase 42 Fiscal source review packet

This packet records the simulation-only interpretation provisionally approved by the
workspace owner. Comprehensive independent Fiscal review is deferred until the Fiscal
program is complete; see the source manifest for the exact approval and scope.

## Exact proposed simulation tuple

- NF-e model 55, simulation environment, normal intrastate SP sale, NCM `09012100`,
  issue date in 2026, the configured issuer establishment and RTC V0057 calculation
  fixture `rtc-v0057-model55-normal-sale-sp-2026-01`.
- Document layout: official PL 010f v1.04 archive, SHA-256
  `b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998`.
- Cancellation envelope candidate: official PL 010d v1.03 archive, SHA-256
  `45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b`.
- MOC 7.0 and NT 2026.004 v1.01 / NT 2025.002 v1.51 are retained by exact digest in
  [the source manifest](fiscal-phase42-source-manifest.json). Run
  `make verify-phase42-sources` before reviewing extracted files.

## Decision requiring review

PL 010f permits alphanumeric issuer positions in the access key. The older dedicated
cancellation XSD package retained in the manifest restricts the CNPJ and key to digits.
PL 010d v1.03 accepts the alphanumeric key in its generic event envelope, but its
`detEvento` content is lax. The current adapter supplies `descEvento`, `nProt` and
`xJust` and validates their values in application code. The generic envelope and XML
signature pass the pinned PL 010d schema and independent signature checks.

The workspace owner accepted PL 010f for the document and PL 010d for the event for
this **simulation-only** tuple, including the application cancellation detail checks.
The capability review records the interpretation, reviewer, selected digests and fixture.
Comprehensive independent Fiscal review remains deferred by owner decision.

## Executable material

- `fiscal/src/nfe55/xml.spec.ts`: signed NF-e golden bytes, PL 010f validation and
  mutation negatives.
- `fiscal/src/nfe55/cancellation-event.spec.ts`: signed alphanumeric-key event, PL 010d
  envelope validation and detail negatives.
- `fiscal/src/nfe55/access-key.spec.ts`: modulo-11 check digit and key fields.
- `fiscal/src/nfe55/danfe.spec.ts`: deterministic simulation watermark outputs.
- `fiscal/test/rules.e2e-spec.ts`: capability review/activation guard and immutable
  lifecycle persistence.
- `fiscal/test/phase42-flow.e2e-spec.ts`: isolated, test-only full manual origin to
  cancellation flow with signed XML, timeout consultation and artifact verification.

No SEFAZ request is performed by these tests or by the Phase 42 simulator.
