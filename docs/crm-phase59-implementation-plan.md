# Phase 59 — Forecast and pipeline metrics rebuilt from history

Status: **delivered on 2026-09-27** ([evidence](crm-phase59-evidence.md)). This is the execution record for
[Phase 59 of the CRM plan](crm-implementation-plan.md#59--forecast-and-pipeline-metrics-rebuilt-from-history).
Decisions: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## Result

After this phase CRM answers two questions as of a declared **cutoff instant**:

- **Forecast** by month:
  - open value by expected close month;
  - weighted value (value × the stage's probability);
  - won value by the month it was won;
  - grouped by pipeline, owner or source, and filtered by any of them.
- **Pipeline metrics** over a window:
  - stage-to-stage conversion;
  - entries and exits per stage;
  - time in stage (count, average, median);
  - win rate;
  - loss reasons.

Both read **metric projections** kept in the same transaction as the opportunity history.
A bounded command drops and rebuilds them from the history alone. It reports progress and
any drift, and compares the numbers before and after.

## Starting point

- The opportunity history (`opportunity_events`) is append-only and complete. Every fact
  records the stage and its probability, the owner, the source, the value, the close date
  and the loss reason in effect after it (Phases 56 and 58).
- `occurred_at` is the instant CRM recorded the fact. Business dates (`closedOn`,
  `expectedCloseOn`) are separate fields.
- Nothing stops a fact from being inserted with an old `occurred_at`. Today only CRM's own
  clock writes it.

## Decisions frozen by this plan

1. **The projections are a pure function of one opportunity's history.**
   - `metricRowsOf(history)` gives three sets of rows:
     - **states**: what the opportunity looked like from each fact until the next;
     - **stage visits**: entered, left, and how it left (moved, won or lost);
     - **closures**: each win or loss, until a reopening supersedes it.
   - Saving an opportunity replaces its rows in the same transaction as its new facts. The
     rebuild runs the same function over the stored history.
   - The live rows and a rebuild can differ only if a row was edited, lost, or written by an
     earlier version of the function. The rebuild reports that drift.
2. **Metrics read recorded instants, not business dates.**
   - A fact counts when its recording instant is at or before the cutoff. A window
     `[from, to]` is also in recorded instants.
   - The forecast reads the state in effect at the cutoff. Open value goes to the expected
     close month, and won value to the month of `closedOn`.
   - A closure superseded by a reopening at or before the cutoff does not count. After the
     cutoff it still counts.
3. **A closed cutoff cannot change.**
   - The history refuses a fact recorded more than **2 minutes** away from the database
     clock, in either direction (trigger).
   - A cutoff older than **10 minutes** is reported as `settled`: no fact recorded before
     it can still arrive. A replayed event adds nothing, because the inbox and the
     aggregates are idempotent (Phases 56 and 58).
4. **Money is summed per currency, in minor units.** A weighted value is
   `round(Σ amount × probabilityBps / 10000)`, half away from zero, per group.
5. **The rebuild is bounded and resumable.**
   - `npm run rebuild:metrics -- --tenant <uuid> [--batch 200] [--verify-only]` walks the
     opportunities by id in batches.
   - Each batch runs in its own transaction, with each opportunity locked while its rows
     are replaced.
   - It prints progress per batch, counts the opportunities whose stored rows differ from
     the recomputed ones, and compares the forecast and the metrics of every pipeline
     before and after at one fixed cutoff.
   - The numbers may change only when drift was found: the first run after the migration
     finds every older opportunity without rows. It exits non-zero if they changed without
     drift, or if a verification after the rebuild still finds drift.
6. **Reads are for anyone with `read`.** The projections hold ids, amounts and dates, never
   a title.

## Work

### A — CRM

1. **Domain:** `metricRowsOf(history)` in `domain/services/opportunity-metrics.ts`.
2. **Application:** `RebuildMetricsUseCase`, which verifies and rebuilds in batches, and the
   `MetricsRepository` port (replace, stored rows, ids by batch).
3. **Migration `0004_pipeline_metrics`:**
   - `metric_states`, `metric_stage_visits` and `metric_closures`, with forced RLS and
     grants;
   - the history's instant tolerance trigger.
4. **Infrastructure:**
   - the store replaces an opportunity's rows whenever it appends history;
   - `metric-reads.ts` for the forecast and the pipeline metrics;
   - the CLI `src/main/rebuild-metrics.ts`.
5. **HTTP:**
   - `GET /forecast?cutoff=&groupBy=pipeline|owner|source&pipelineId=&ownerId=&sourceId=`;
   - `GET /pipelines/{id}/metrics?from=&to=&cutoff=`.

   Both answer the cutoff they used and whether it is settled.

### B — Evidence

1. Unit tests for `metricRowsOf`:
   - moves, reassignment, revision, win, loss, reopening and conversion;
   - a conversion from lost;
   - the same rows whatever order the stored facts come back in.
2. Unit tests for the rebuild use case with the in-memory store: batches, progress and
   drift.
3. e2e on PostgreSQL:
   - forecast and metrics numbers checked by hand on a small pipeline;
   - the three tables emptied, then rebuilt: the same numbers, and no drift;
   - a hand-edited row found as drift and repaired;
   - a back-dated fact refused;
   - later facts and replayed events leave the numbers at an earlier cutoff unchanged;
   - RLS on the new tables.
4. `scripts/phase59-smoke.mjs` through Kong: a pipeline worked through its stages, the
   forecast and the metrics read, the rebuild CLI run inside the CRM container with the
   same numbers.
5. `make check`, the CRM e2e, `make ci-local`, and isolated jobs.

## Exit evidence

- Dropping and rebuilding the metrics gives the same numbers as the live projection.
- A back-dated or replayed event cannot change a closed cutoff.

## Revisions made while implementing

- **The exit code of the rebuild.** The plan said "non-zero if the numbers differ". The
  first run after the migration fills the rows of every older opportunity, so its numbers
  must change. The command now fails only when numbers change without drift, or when drift
  remains after the rebuild.
- **Instants in raw SQL.** The drizzle `sql` template does not serialize a `Date` for
  postgres.js, so the metric reads pass instants as ISO text cast to `timestamptz`.
- **Restores.** The tolerance trigger fires on every insert into `opportunity_events`. A
  restore of CRM data (Phase 60) must load the history with triggers disabled, as a
  data-only restore does with `--disable-triggers`.

## Out of scope

- Screens and charts (Phase 60).
- Cross-module dashboards (Phase M).
- Converting currencies: every figure stays in its own currency.
