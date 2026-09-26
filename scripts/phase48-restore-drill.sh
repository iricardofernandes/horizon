#!/usr/bin/env bash
# Phase 48 artifact restore drill on the local stack.
#
# Dumps the Fiscal database and copies the encrypted artifact volume into new, isolated
# containers, starts a Fiscal that sees only those restored stores (its own broker vhost,
# no tenant served by the worker, so it issues and publishes nothing), and verifies every
# artifact of NF-e 55, NFC-e 65 and NFS-e documents byte for byte against the live one.
#
#   scripts/phase48-restore-drill.sh [tenant-uuid]
#
# The restored containers, volume and vhost are kept for inspection; `docker rm -f`,
# `docker volume rm` and `rabbitmqctl delete_vhost` with the names below remove them.
set -euo pipefail

TENANT="${1:-01a0c5f8-798b-721e-912e-9b505406e614}"
PREFIX=horizon-phase48-restore
NETWORK=horizon
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HORIZON_RESTORE_FISCAL_PORT:-13011}"

docker rm -f "$PREFIX-fiscal" "$PREFIX-minio" "$PREFIX-postgres" "$PREFIX-rabbitmq" >/dev/null 2>&1 || true
docker volume rm "$PREFIX-artifacts" >/dev/null 2>&1 || true

echo "== dump horizon_fiscal"
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
docker exec horizon-postgres pg_dump -U postgres -d horizon_fiscal --format=custom >"$DUMP"
sha256sum "$DUMP" | cut -d' ' -f1 | sed 's/^/dump sha256 /'

echo "== restore into a new PostgreSQL"
docker run -d --name "$PREFIX-postgres" --network "$NETWORK" \
  -e POSTGRES_PASSWORD=restore postgres:17-alpine >/dev/null
until docker exec "$PREFIX-postgres" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 2
for statement in \
  "CREATE ROLE horizon_owner LOGIN PASSWORD 'horizon' NOSUPERUSER NOBYPASSRLS" \
  "CREATE ROLE horizon_app LOGIN PASSWORD 'horizon' NOSUPERUSER NOBYPASSRLS" \
  "CREATE DATABASE horizon_fiscal OWNER horizon_owner"; do
  docker exec "$PREFIX-postgres" psql -U postgres -q -v ON_ERROR_STOP=1 -c "$statement"
done
# Objects belong to horizon_owner again; the dump's grants and RLS policies are replayed.
docker exec -i "$PREFIX-postgres" pg_restore -U postgres -d horizon_fiscal --no-owner \
  --role=horizon_owner --exit-on-error <"$DUMP"

echo "== copy the encrypted artifact volume"
docker volume create "$PREFIX-artifacts" >/dev/null
docker run --rm -v horizon_fiscal-artifacts:/from:ro -v "$PREFIX-artifacts":/to alpine \
  sh -c 'cp -a /from/. /to/'
docker run -d --name "$PREFIX-minio" --network "$NETWORK" -v "$PREFIX-artifacts":/data \
  -e MINIO_ROOT_USER=horizon-fiscal-local -e MINIO_ROOT_PASSWORD=horizon-fiscal-local-secret \
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z server /data >/dev/null
# A vhost of its own on the local broker: the restored Fiscal shares no queue or exchange
# with the live one.
docker exec horizon-rabbitmq rabbitmqctl -q delete_vhost phase48-restore >/dev/null 2>&1 || true
docker exec horizon-rabbitmq rabbitmqctl -q add_vhost phase48-restore
docker exec horizon-rabbitmq rabbitmqctl -q set_permissions -p phase48-restore horizon '.*' '.*' '.*'

echo "== start a Fiscal that sees only the restored stores"
ENV_FILE="$(mktemp)"
trap 'rm -f "$DUMP" "$ENV_FILE"' EXIT
docker inspect horizon-fiscal --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -Ev '^(DATABASE_URL|FISCAL_ARTIFACT_ENDPOINT|RABBITMQ_URL|FISCAL_SERVICE_KEYS_JSON|PATH|NODE_VERSION|YARN_VERSION|OTEL_[A-Z_]+)=' \
  >"$ENV_FILE"
cat >>"$ENV_FILE" <<EOF
DATABASE_URL=postgres://horizon_app:horizon@$PREFIX-postgres:5432/horizon_fiscal
FISCAL_ARTIFACT_ENDPOINT=http://$PREFIX-minio:9000
RABBITMQ_URL=amqp://horizon:horizon@rabbitmq:5672/phase48-restore
FISCAL_SERVICE_KEYS_JSON={}
OTEL_SDK_DISABLED=true
EOF
docker run -d --name "$PREFIX-fiscal" --network "$NETWORK" -p "$PORT:3011" \
  -v "$ROOT/fiscal/fixtures/official:/run/fiscal-schemas:ro" \
  -v "$ROOT/infra/keys/fiscal:/run/fiscal-keys:ro" \
  --env-file "$ENV_FILE" horizon-fiscal >/dev/null
for attempt in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 2
done

echo "== verify"
node "$ROOT/scripts/phase48-verify-restore.mjs" --tenant "$TENANT" \
  --restored "http://localhost:$PORT"
echo "== verify again after restarting the restored Fiscal and MinIO"
docker restart "$PREFIX-minio" "$PREFIX-fiscal" >/dev/null
for attempt in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 2
done
node "$ROOT/scripts/phase48-verify-restore.mjs" --tenant "$TENANT" \
  --restored "http://localhost:$PORT" --summary
