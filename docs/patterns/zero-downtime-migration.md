# Zero-downtime database migration

Extracted from the executable Catalog exercise in
[`catalog/test/database.e2e-spec.ts`](../../catalog/test/database.e2e-spec.ts). Its four
SQL checkpoints are in
[`catalog/test/fixtures/migrations/price-list-name/`](../../catalog/test/fixtures/migrations/price-list-name/).
The exercise runs against PostgreSQL 17 and renames a populated price-list field while
old and new writers overlap. It uses a structural twin of the real table: changing a
stable production column merely to manufacture migration evidence would add risk without
adding product value.

Expand/contract is a release sequence, not a clever `ALTER TABLE`. At every checkpoint,
the currently deployed binary and the immediately preceding binary must both work. A
rename therefore takes at least three application releases; putting all phases in one
migration file destroys the compatibility window.

## 1. State the compatibility matrix

Write the allowed binaries and schemas before writing SQL:

| Checkpoint | Database accepts | Application reads | Safe rollback |
|---|---|---|---|
| Before | old shape | old | old binary |
| Expand | old and new shapes | old, with fallback permitted | old binary |
| Cutover | old and new shapes | new only | compatibility binary |
| Contract | new shape only | new | roll forward only |

Include HTTP processes, relay processes, consumers, cron jobs and operator scripts. A
queue may retain an old message longer than an HTTP rolling deployment retains an old
process; the contract phase waits for both.

## 2. Expand without rewriting the table

Add the new column as nullable and without a volatile default. Create indexes separately;
on a populated production table use `CREATE INDEX CONCURRENTLY`, which must run outside a
transaction and therefore outside a Drizzle migration that wraps the file. Record that
operation in the same release runbook even when it needs a separate command.

Deploy a compatibility binary next. It writes both representations and can read the new
one with a fallback to the old one. Catalog's exercise uses a temporary database trigger
as a compatibility dual-write: an old writer that supplies only `name` and a new writer
that supplies only `display_name` both populate both columns. Reject mismatched values;
silently choosing one makes corruption look like availability.

The trigger is not the preferred permanent design. It is a bridge with an owner and a
removal checkpoint. Application dual-write is suitable when every writer can be upgraded
together; a trigger is safer when an old binary may still write during a rolling deploy.

## 3. Backfill in bounded, resumable batches

Never issue one unbounded update against a business table. Select a small, stable batch
of rows still missing the new representation with `FOR UPDATE SKIP LOCKED`, update that
batch, commit, and repeat. The predicate makes the job idempotent and the lock clause lets
multiple workers cooperate rather than wait on one another.

Measure remaining rows, batch duration, rows per second, lock waits and replication lag.
Throttle on the database signals, not on an arbitrary sleep. Stop safely on error; the
next invocation resumes from the remaining-row predicate.

Horizon tables use forced RLS. A backfill must not borrow the unrestricted migration
connection or disable RLS while the service is live. Run the normal tenant transaction
for one known tenant at a time, or provision a dedicated maintenance role with an
explicit, reviewed policy. The role and policy are part of the migration and are removed
afterward. Superuser and `BYPASSRLS` are not application shortcuts.

## 4. Prove convergence, then cut reads over

The gate is data, not elapsed time. Require all of the following before cutover:

- no row is missing the new value;
- old and new values agree wherever both exist;
- the new unique index or foreign key is valid;
- error rate, lock waits and replication lag stayed within the recorded limits;
- the compatibility binary has been healthy for a complete workload cycle.

Add new constraints with `NOT VALID`, validate them against existing rows, then make the
column `NOT NULL`. Deploy the cutover binary, which reads only the new representation but
continues compatibility writes. Rollback at this checkpoint means redeploying the
compatibility binary; it does not mean reversing the data migration.

## 5. Contract only after old work is impossible

Inventory every old process and message source. Wait until the oldest possible old binary
and oldest queued job have drained, then remove the compatibility write, old indexes and
constraints, and finally the old column. A drop is deliberately last because it is the
first irreversible checkpoint.

Take a backup or verified restore point before contraction. Afterward, repeat the
convergence query through the new application path and watch database errors for unknown
columns. If an old writer appears after the drop, roll forward by expanding compatibility
again; do not restore the whole database over newer business writes.

## Required evidence in a new module

A migration is complete only when its test starts with rows in the old shape, exercises
an old and a new writer during the overlap, runs a bounded backfill, enforces the new
constraint, reads only the new shape, drops the old shape and proves every value survived.
The test must use the module's real database version. A mocked repository cannot prove
DDL locks, trigger order, constraints or PostgreSQL syntax.

Keep the final Drizzle schema at the contracted target state. Hand-write the transitional
SQL and never regenerate an old migration after it has shipped. The operational record
must name the checkpoint, gate query, rollback boundary and responsible role for each
phase.
