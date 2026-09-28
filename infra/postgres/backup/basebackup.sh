#!/bin/sh
# Scheduled base backups (ADR 0063, Phase 69).
#
# Takes a compressed tar base backup through the cluster's local socket, writes a manifest
# beside it (label, start WAL, size, SHA-256), keeps the newest BASEBACKUP_KEEP, and removes
# the archived WAL older than the oldest backup kept. WAL itself is not in the backup
# (-X none): the archive supplies it at restore, which is what makes point-in-time
# recovery possible.
#
#   basebackup.sh          take one now if the last is older than the interval, then loop
#   basebackup.sh once     take one now and exit
set -eu

BASE=/backups/base
WAL=/backups/wal
INTERVAL="${BASEBACKUP_INTERVAL_SECONDS:-21600}"
KEEP="${BASEBACKUP_KEEP:-7}"

log() { printf '{"time":"%s","event":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}"; }

take() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$BASE/$stamp.partial"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$work"
  if ! pg_basebackup -h /var/run/postgresql -U postgres -D "$work" -Ft -z -X none \
      -c fast -l "horizon-$stamp" --manifest-checksums=SHA256 >/dev/null 2>/tmp/basebackup.err; then
    log basebackup.failed ",\"stamp\":\"$stamp\",\"error\":\"$(tr '"\n' "' " </tmp/basebackup.err)\""
    rm -rf "$work"
    return 1
  fi
  # The server archives a history file naming the backup's first WAL segment.
  history="$(grep -l "LABEL: horizon-$stamp" "$WAL"/*.backup 2>/dev/null | head -n 1 || true)"
  start_wal="$(sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]*\))$/\1/p' "$history" 2>/dev/null || true)"
  size="$(du -sb "$work" | cut -f1)"
  digest="$(sha256sum "$work/base.tar.gz" | cut -d' ' -f1)"
  printf '{"stamp":"%s","label":"horizon-%s","startedAt":"%s","finishedAt":"%s","startWal":"%s","history":"%s","sizeBytes":%s,"sha256":"%s"}\n' \
    "$stamp" "$stamp" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$start_wal" "$(basename "${history:-none}")" \
    "$size" "$digest" >"$work/manifest.json"
  mv "$work" "$BASE/$stamp"
  log basebackup.taken ",\"stamp\":\"$stamp\",\"startWal\":\"$start_wal\",\"sizeBytes\":$size"
  prune
}

prune() {
  # Newest first; everything past KEEP goes, and the WAL before the oldest kept with it.
  ls -1 "$BASE" | grep -v partial | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -rf "${BASE:?}/$old"
    log basebackup.removed ",\"stamp\":\"$old\""
  done
  oldest="$(ls -1 "$BASE" | grep -v partial | sort | head -n 1)"
  [ -n "$oldest" ] || return 0
  history="$(sed -n 's/.*"history":"\([^"]*\)".*/\1/p' "$BASE/$oldest/manifest.json")"
  if [ -n "$history" ] && [ "$history" != none ] && [ -f "$WAL/$history" ]; then
    pg_archivecleanup "$WAL" "$history"
    log wal.cleaned ",\"keptFrom\":\"$history\""
  fi
}

latest_age() {
  latest="$(ls -1 "$BASE" 2>/dev/null | grep -v partial | sort -r | head -n 1)"
  [ -n "$latest" ] || { echo 999999999; return; }
  then_s="$(date -u -d "$(echo "$latest" | sed 's/\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z/\1-\2-\3 \4:\5:\6/')" +%s)"
  echo "$(( $(date -u +%s) - then_s ))"
}

until pg_isready -h /var/run/postgresql -U postgres >/dev/null 2>&1; do sleep 2; done
if [ "${1:-}" = once ]; then take; exit $?; fi
while true; do
  age="$(latest_age)"
  if [ "$age" -ge "$INTERVAL" ]; then take || true; age=0; fi
  sleep "$(( INTERVAL - age ))"
done
