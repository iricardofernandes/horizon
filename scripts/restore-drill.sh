#!/usr/bin/env bash
# The full restore drill (ADR 0063, Phase 69), on the local stack.
#
# From the backups alone, it builds a fresh stack beside the live one and proves it:
#   1. makes sure a base backup exists within its interval;
#   2. marks the point in time: a row and an object before the target, and after it;
#   3. "fails": the recovery clock starts;
#   4. restores PostgreSQL from the base backup and the WAL archive to the target;
#   5. restores every bucket as it was at the target (versioned objects);
#   6. starts a new Redis, RabbitMQ, every service from its built image with the live
#      environment rewritten to the drill's stores, and a Kong of its own on port 18000;
#   7. verifies it (scripts/restore-drill-verify.mjs) and stores the evidence in docs/drills/.
#
#   scripts/restore-drill.sh [--keep]
#
# --keep leaves the drill stack running for inspection; otherwise it is removed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P=horizon-drill
NETWORK=horizon
KEEP=false
[ "${1:-}" = --keep ] && KEEP=true
RUN="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
SERVICES=(identity catalog inventory sales webhooks parties financial treasury ledger procurement fiscal crm reporting files agent)
MINIO_IMAGE="$(docker inspect horizon-minio --format '{{.Config.Image}}')"
MC_IMAGE="$(docker inspect horizon-minio-init-1 --format '{{.Config.Image}}' 2>/dev/null || echo pgsty/mc)"
MINIO_USER="$(docker exec horizon-minio printenv MINIO_ROOT_USER)"
MINIO_PASSWORD="$(docker exec horizon-minio printenv MINIO_ROOT_PASSWORD)"
BUCKETS=(horizon-fiscal-artifacts horizon-exports horizon-attachments)
TIMINGS="$WORK/timings"
: >"$TIMINGS"

now_ms() { date +%s%3N; }
# Waits until a command succeeds, or fails the drill after a deadline: a step that cannot
# finish must stop the drill with its reason, never hang it.
wait_for() {
  local what="$1" seconds="$2"; shift 2
  local deadline=$(( $(date +%s) + seconds ))
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -gt "$deadline" ]; then echo "timed out waiting for $what"; exit 1; fi
    sleep 2
  done
}
http_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = 200 ]; }
mark() { echo "$1 $(now_ms)" >>"$TIMINGS"; echo "== $1"; }
live_sql() { docker exec horizon-postgres psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
drill_sql() { docker exec "$P-postgres" psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
mc_run() {
  docker run --rm --network "$NETWORK" --entrypoint /bin/sh "$MC_IMAGE" -ec "
    mc alias set live http://minio:9000 '$MINIO_USER' '$MINIO_PASSWORD' >/dev/null
    mc alias set drill http://$P-minio:9000 '$MINIO_USER' '$MINIO_PASSWORD' >/dev/null 2>&1 || true
    $1"
}

cleanup() {
  rm -rf "$WORK"
  if [ "$KEEP" = false ]; then
    docker rm -f "$P-kong" "${SERVICES[@]/#/$P-}" "$P-redis" "$P-rabbitmq" "$P-minio" "$P-postgres" \
      >/dev/null 2>&1 || true
    docker volume rm "$P-pgdata" "$P-objects" "$P-rabbitmq" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
cleanup_previous() {
  docker rm -f "$P-kong" "${SERVICES[@]/#/$P-}" "$P-redis" "$P-rabbitmq" "$P-minio" "$P-postgres" \
    >/dev/null 2>&1 || true
  docker volume rm "$P-pgdata" "$P-objects" "$P-rabbitmq" >/dev/null 2>&1 || true
}
cleanup_previous

# --- 1. a base backup within its interval ---------------------------------------------------
mark backup
INTERVAL="$(docker exec horizon-postgres-backup printenv BASEBACKUP_INTERVAL_SECONDS || echo 21600)"
LATEST="$(docker exec horizon-postgres-backup sh -c 'ls -1 /backups/base | grep -v partial | sort -r | head -n 1')"
if [ -z "$LATEST" ]; then
  docker exec horizon-postgres-backup sh /scripts/basebackup.sh once
  LATEST="$(docker exec horizon-postgres-backup sh -c 'ls -1 /backups/base | grep -v partial | sort -r | head -n 1')"
fi
BACKUP_MANIFEST="$(docker exec horizon-postgres-backup cat "/backups/base/$LATEST/manifest.json")"
echo "base backup $LATEST"

# --- 2. the point in time -------------------------------------------------------------------
mark markers
live_sql -d postgres -c "select 1 from pg_database where datname = 'horizon_drill'" | grep -q 1 ||
  live_sql -d postgres -c "create database horizon_drill"
live_sql -d horizon_drill -c "create table if not exists markers (
  run text not null, label text not null, written_at timestamptz not null default clock_timestamp())"
live_sql -d horizon_drill -c "insert into markers (run, label) values ('$RUN', 'before')" >/dev/null
mc_run "echo before | mc pipe live/horizon-exports/drill/$RUN/before >/dev/null"
sleep 2
# The format recovery_target_time accepts: an ISO date and time with an explicit offset.
AT="$(live_sql -d postgres -c "select clock_timestamp() at time zone 'utc'")"
TARGET="$(live_sql -d postgres -c "select to_char('$AT'::timestamp, 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
TARGET_ISO="$(live_sql -d postgres -c "select to_char('$AT'::timestamp, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
# mc takes the same instant in its own format, to the second (rounded down, never after).
REWIND="$(live_sql -d postgres -c "select to_char('$AT'::timestamp, 'YYYY.MM.DD\"T\"HH24:MI:SS')")"
sleep 2
live_sql -d horizon_drill -c "insert into markers (run, label) values ('$RUN', 'after')" >/dev/null
mc_run "echo after | mc pipe live/horizon-exports/drill/$RUN/after >/dev/null"
# Close the segment holding the second marker, as archive_timeout would within 5 minutes.
SWITCHED="$(live_sql -d postgres -c "select pg_walfile_name(pg_switch_wal())")"
archived() { [ "$(live_sql -d postgres -c "select coalesce(last_archived_wal, '') >= '$SWITCHED' from pg_stat_archiver")" = t ]; }
wait_for "the switched WAL segment to be archived" 120 archived
ARCHIVER="$(live_sql -d postgres -c "select json_build_object(
  'archivedCount', archived_count, 'lastArchivedWal', last_archived_wal,
  'lastArchivedAt', last_archived_time, 'failedCount', failed_count,
  'archiveTimeoutSeconds', current_setting('archive_timeout')::interval)::text
  from pg_stat_archiver")"
echo "target $TARGET"

# --- 3. the failure -------------------------------------------------------------------------
mark failure

# --- 4. PostgreSQL, from the base backup and the WAL, to the target ------------------------
mark restore-postgres
docker volume create "$P-pgdata" >/dev/null
docker run --rm --user root -v "$P-pgdata":/data -v horizon_postgres-base:/backups/base:ro \
  postgres:17-alpine sh -ec "
    tar -xzf /backups/base/$LATEST/base.tar.gz -C /data
    touch /data/recovery.signal
    cat >>/data/postgresql.auto.conf <<CONF
restore_command = 'cp /backups/wal/%f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF
    chown -R 70:70 /data && chmod 700 /data"
docker run -d --name "$P-postgres" --network "$NETWORK" \
  -e PGDATA=/var/lib/postgresql/data -v "$P-pgdata":/var/lib/postgresql/data \
  -v horizon_postgres-wal:/backups/wal:ro postgres:17-alpine \
  postgres -c max_connections=300 -c statement_timeout=30s >/dev/null
deadline=$(( $(date +%s) + 1800 ))
until [ "$(docker exec "$P-postgres" psql -U postgres -Atc 'select not pg_is_in_recovery()' 2>/dev/null)" = t ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$P-postgres")" != true ] || [ "$(date +%s)" -gt "$deadline" ]; then
    docker logs "$P-postgres" 2>&1 | tail -5
    echo "the restored PostgreSQL did not come up"; exit 1
  fi
  sleep 1
done
REPLAYED="$(drill_sql -d postgres -c "select coalesce(pg_last_xact_replay_timestamp()::text, '')")"

# --- 5. every bucket, as it was at the target ----------------------------------------------
mark restore-objects
docker volume create "$P-objects" >/dev/null
docker run -d --name "$P-minio" --network "$NETWORK" -v "$P-objects":/data \
  -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" \
  "$MINIO_IMAGE" server /data >/dev/null
OBJECTS="$(mc_run "
  tries=0
  until mc alias set drill http://$P-minio:9000 '$MINIO_USER' '$MINIO_PASSWORD' >/dev/null 2>&1; do
    tries=\$((tries + 1)); [ \$tries -lt 150 ] || { echo 'the drill MinIO did not come up'; exit 1; }; sleep 2
  done
  for bucket in ${BUCKETS[*]}; do
    mc mb --ignore-existing drill/\$bucket >/dev/null
    mc version enable drill/\$bucket >/dev/null
    mc cp --recursive --rewind '$REWIND' live/\$bucket/ drill/\$bucket/ >/dev/null 2>&1 || true
    echo \"\$bucket \$(mc ls --recursive drill/\$bucket | wc -l)\"
  done")"
echo "$OBJECTS"

# --- 6. a fresh stack on the restored stores -----------------------------------------------
mark start-stack
docker run -d --name "$P-redis" --network "$NETWORK" redis:7-alpine >/dev/null
# A volume of its own, seeded with an Erlang cookie the broker can read: a fresh broker
# volume otherwise leaves the cookie unreadable and the broker stops at once.
docker run --rm -v "$P-rabbitmq":/var/lib/rabbitmq --entrypoint sh rabbitmq:4-management-alpine -c \
  'printf %s "$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z)" >/var/lib/rabbitmq/.erlang.cookie &&
   chown rabbitmq:rabbitmq /var/lib/rabbitmq/.erlang.cookie && chmod 400 /var/lib/rabbitmq/.erlang.cookie'
docker run -d --name "$P-rabbitmq" --network "$NETWORK" -v "$P-rabbitmq":/var/lib/rabbitmq \
  -e RABBITMQ_DEFAULT_USER=horizon -e RABBITMQ_DEFAULT_PASS=horizon rabbitmq:4-management-alpine >/dev/null
wait_for "the drill RabbitMQ" 300 docker exec "$P-rabbitmq" rabbitmq-diagnostics -q check_running

REWRITE=(-e "s#@postgres:5432#@$P-postgres:5432#g" -e "s#redis://redis:#redis://$P-redis:#g"
  -e "s#@rabbitmq:5672#@$P-rabbitmq:5672#g" -e "s#http://rabbitmq:15672#http://$P-rabbitmq:15672#g"
  -e "s#http://minio:9000#http://$P-minio:9000#g" -e "s#http://kong:8000#http://$P-kong:8000#g")
for service in "${SERVICES[@]}"; do REWRITE+=(-e "s#http://$service:#http://$P-$service:#g"); done

for service in "${SERVICES[@]}"; do
  live="horizon-$service"
  image="$(docker inspect "$live" --format '{{.Config.Image}}')"
  user="$(docker inspect "$live" --format '{{.Config.User}}')"
  env_file="$WORK/$service.env"
  docker inspect "$live" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    sed "${REWRITE[@]}" | grep -v '^$' >"$env_file"
  # The drill runs no schedule of its own and sends no telemetry to the live collector.
  printf 'OTEL_SDK_DISABLED=true\nCONTROLS_FIRST_DELAY_SECONDS=86400\n' >>"$env_file"
  mounts=()
  while read -r source destination; do
    [ -n "$source" ] && mounts+=(-v "$source:$destination:ro")
  done < <(docker inspect "$live" --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source .Destination}}{{end}}{{end}}')
  cmd=()
  while read -r part; do [ -n "$part" ] && cmd+=("$part"); done < <(
    docker inspect "$live" --format '{{range .Config.Cmd}}{{println .}}{{end}}')
  docker run -d --name "$P-$service" --network "$NETWORK" --env-file "$env_file" \
    ${user:+--user "$user"} "${mounts[@]}" "$image" "${cmd[@]}" >/dev/null
done

ALTERNATION="$(IFS='|'; echo "${SERVICES[*]}")"
sed -E "s#http://($ALTERNATION):#http://$P-\\1:#g" "$ROOT/infra/generated/kong.generated.yml" >"$WORK/kong.yml"
# Never verify, or write, through a gateway that still reaches the live services.
if grep -E "url: http://($ALTERNATION):" "$WORK/kong.yml" >/dev/null; then
  echo "the drill gateway still points at live services"; exit 1
fi
[ "$(grep -c "url: http://$P-" "$WORK/kong.yml")" -ge "${#SERVICES[@]}" ] ||
  { echo "the drill gateway does not route to every drill service"; exit 1; }
chmod 644 "$WORK/kong.yml"
kong_env="$WORK/kong.env"
docker inspect horizon-kong --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^KONG_' >"$kong_env"
docker run -d --name "$P-kong" --network "$NETWORK" --env-file "$kong_env" \
  -v "$WORK/kong.yml":/kong/kong.yml:ro -p 18000:8000 kong:3.9 >/dev/null
for service in identity catalog inventory sales parties financial treasury ledger procurement crm reporting files agent; do
  wait_for "$service in the drill stack" 600 http_ok "http://localhost:18000/$service/health/ready"
done
wait_for "the drill gateway's JWKS" 300 http_ok http://localhost:18000/.well-known/jwks.json
mark stack-ready

# --- 7. verify, and store the evidence ------------------------------------------------------
BUCKET_COUNTS="$(echo "$OBJECTS" | awk '{printf "%s\"%s\":%s", (NR>1?",":""), $1, $2}')"
DRILL_RUN="$RUN" DRILL_TARGET="$TARGET_ISO" DRILL_TIMINGS="$TIMINGS" DRILL_BACKUP="$BACKUP_MANIFEST" \
  DRILL_ARCHIVER="$ARCHIVER" DRILL_BUCKETS="{$BUCKET_COUNTS}" DRILL_REPLAYED="$REPLAYED" \
  DRILL_INTERVAL="$INTERVAL" DRILL_PREFIX="$P" \
  node "$ROOT/scripts/restore-drill-verify.mjs"
