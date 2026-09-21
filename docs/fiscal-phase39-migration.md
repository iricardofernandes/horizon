# Phase 39 fiscal data migration and cutover

The expanded owner schemas preserve every existing identifier and commercial snapshot.
New fiscal profile and classification revisions start at zero for old rows. Zero means
**unverified**, not a guessed address, issuer municipality or NCM. No old Sales shipment
is re-dispatched to create a fiscal document.

## Expand

Deploy contract version 0.23.0 to consumers before enabling the new producers. Apply
the additive migrations in Parties, Identity, Catalog and Sales, then the independent
Fiscal migration. The new columns are nullable or have a revision-zero default; old
readers continue to use the old fields. Retain old columns and legacy events during the
compatibility window. The fiscal capability matrix remains `unsupported` for every
issuer and jurisdiction.

## Verify and backfill owner data

1. For each issuer, an Identity owner submits the company profile with an IBGE
   municipality code and effective date. The restricted company export reports the
   tenant and exact revision. A revision-zero issuer remains blocked.
2. For each recipient needed by an unissued document, a Parties editor verifies the
   structured address, registrations and recipient flags and records an effective date.
   Free-text addresses are never parsed into official fields automatically. An erased
   party cannot be reintroduced by a late backfill.
3. Catalog managers classify the items needed for fiscal documents. A legacy NCM on an
   item is not silently treated as a verified revision.
4. Use a tenant-scoped Identity API key whose issuer has both `fiscal-reader` roles,
   run `fiscal npm run backfill`, and
   retain its source counts, committed checkpoint counts, projection counts and rolling
   digests in the migration record. The command fails if the checkpoint differs from
   the scan or the projection has fewer revisions. It pages only owner HTTP APIs,
   fetches exact revisions and checkpoints after a complete page. Rerun
   to reconcile changes made during the first scan. An HTTP error, missing revision,
   tenant mismatch or revision conflict stops the job; fix the owner data, then resume.
5. Compare the owner page counts and current revision numbers with the Fiscal checkpoint
   counts, then investigate any extra projected revisions from concurrent notices.
   Investigate missing profiles and broker dead-letter entries before any
   capability is enabled. The cross-tenant negative case and erasure tombstone are
   exercised by `fiscal npm run test:e2e`.

## Old Sales shipments

Sales remains the owner of past dispatches and returns. Existing stock movements and
receivables are facts and must not be replayed. A historical `sales.invoicing.requested`
event may be transformed into a fiscal origin only if it names a real shipment; the
shipment id, not the order id, becomes `origin_id`. Events without a shipment id are
quarantined for operator reconciliation. Importing or linking an already issued legacy
fiscal document needs a separate reviewed operation in Fiscal; it must not transmit a
second document. The new Sales origin event is the only live trigger after cutover.

## Cutover and rollback

The Phase 39 worker may create only `blocked_profile` intents. It cannot transmit to an
authority. Keep every capability `unsupported` until the relevant adapter, tax review,
homologation evidence and operational approval are recorded. The model 55 pre-dispatch
gate is activated with the later authorization lifecycle, never by a simulated status.

If the new consumer is stopped, Sales, Inventory and Financial keep their existing
operational facts. Restarting Fiscal replays its durable queue and inbox safely. A
rollback disables the consumer and leaves expanded columns, owner history and the
unique origin keys intact; dropping them would lose the reconciliation path.
