# Phase 42 local completion evidence

Status: **complete for the local NF-e model 55 simulation tuple** on 2026-09-22 (America/Sao_Paulo). The workspace owner provisionally approved the PL 010f/PL 010d interpretation and deferred the comprehensive Fiscal review until the Fiscal program is complete. No SEFAZ or production credential was used.

## Sources, code and activation

- `make verify-phase42-sources` verified six retained official artifacts. The selected document and event package SHA-256 digests are `b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998` and `45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b`.
- [The source manifest](fiscal-phase42-source-manifest.json), SHA-256 `02aeb665d996fc0eca3203048e43e2cce5f980add9f41a767c8e37e449a3c44e`, records the owner approval and limited scope.
- `make ci-local` passed with Node 24 after the Fiscal changes: cross-module builds, typechecks, lint, unit and PostgreSQL integration tests, contract compatibility, boundaries and secret scan. The isolated Phase 42 lifecycle test covers concurrent idempotency, correction, timeout recovery, cancellation, clean restore and rollback.
- A local simulation-only RSA certificate and owner fixtures were configured outside Git. The tenant-scoped backfill reconciled three party revisions, two issuer revisions and one Catalog classification. Three approved Phase 41 rules were activated.
- [Preactivation evidence](fiscal-phase42-preactivation-evidence.json), SHA-256 `7265b0d53adb19cd90402471c8b6bfde392518b830804876b7dbec221613a803`, was bound to activation event `5aa16071-3ca9-4182-b9d9-4786c96237c1` for capability `6c6c73d4-1445-4f9b-be69-2dfee757ce79`. Only the reviewed model 55, SP, normal-sale simulation tuple is active in the local tenant.

## Kong lifecycle and recovery

`scripts/phase42-smoke.mjs` completed through Kong for tenant `01a0c5f8-798b-721e-912e-9b505406e614` and document `ad88f4ab-3986-4478-9f94-b9e3e42135cb`: idempotent manual origin and draft, readiness/calculation binding, idempotent issue, authorization, artifact downloads, cancellation and transition history. All 11 distinct artifacts were downloaded and checked against their recorded SHA-256 and byte size. The signed XML digest and access key remain in ignored local smoke evidence.

The first simulator issuance response was `unknown`; consultation returned `authorized`. Both cite request digest `1f1359b5fa002eef5fcdd3e0b245a3e72c7638b3d7d4e0be4ecdcfac6cb01b0d`. Fiscal was restarted while the document was `unknown`. The database records one `issuance` command, two worker attempts, one response observation and one consultation observation. Cancellation followed the same pattern: one command, two attempts, `unknown` response then `cancelled` consultation. No second issuance submission was recorded. The outbox has one delivered `simulation-authorized` and one delivered `simulation-cancelled` event for this document.

The first restart attempt caused a transient Kong 502 and stopped that smoke process. Its document recovered to `authorized` after restart. The smoke now retries 502/503 while polling a restarted service; the second complete run passed.

Sales, Inventory and Financial database dumps contain no row referencing the smoke document ID or its access key. Their consumers have no handler for Fiscal simulation events. This verifies observed local isolation.

## Clean restore and rollback

The configured local PostgreSQL database was dumped and restored into a new PostgreSQL container. The MinIO artifact volume was copied into a separate volume and served by a new MinIO container. A separate Fiscal container pointing only at those restored stores passed `scripts/phase42-verify-restore.mjs` over HTTP: all 18 references from the before/after smoke lists matched the 11 distinct artifact bytes and digests; another tenant received 404. The check passed again after restarting both restored Fiscal and MinIO.

The restored capability was deactivated. Its active capability list became empty, while artifact and cross-tenant verification still passed. The original local simulation capability remains active for development. Ignored execution artifacts are under `infra/keys/fiscal/`; temporary restored containers and volume are retained for inspection.

The comprehensive Fiscal source interpretation review remains deferred by explicit owner decision. Phase 43 owns real SEFAZ integration and operational dispatch.
