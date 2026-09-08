#!/usr/bin/env bash
#
# Stand up a throwaway registry in the current CI job, publish @horizon/contracts to it,
# and point npm at it.
#
# WHY. A module depends on `@horizon/contracts` by *version*, never by path (ADR 0029) —
# a `file:` dependency has no version and so cannot express a breaking change. That means
# `npm ci` for a module needs a registry serving the pinned version.
#
# Rather than publish to a hosted registry and manage tokens and cross-job ordering, each
# job runs its own Verdaccio for the ninety seconds it needs one. It is hermetic, needs no
# secrets, and works identically on a pull request and on main.
#
#   scripts/ci-publish-contracts.sh [--drop-source]
#
# --drop-source deletes contracts/ after publishing. The isolation workflow uses it: once
# the source is gone from disk, a module that still installs and builds has proven it
# resolves the package from the registry rather than from its sibling's source tree.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY_PORT="${HORIZON_VERDACCIO_PORT:-4873}"
REGISTRY="http://localhost:${REGISTRY_PORT}"
DROP_SOURCE=false

[[ "${1:-}" == "--drop-source" ]] && DROP_SOURCE=true

echo "starting verdaccio on ${REGISTRY}"
docker run -d --rm \
  --name horizon-ci-registry \
  -p "${REGISTRY_PORT}:4873" \
  -v "${ROOT}/infra/verdaccio/config.yaml:/verdaccio/conf/config.yaml:ro" \
  verdaccio/verdaccio:6 >/dev/null

for _ in $(seq 1 60); do
  if curl -sf "${REGISTRY}/-/ping" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "${REGISTRY}/-/ping" >/dev/null || { echo "verdaccio did not come up" >&2; exit 1; }

echo "building and publishing @horizon/contracts"
cd "${ROOT}/contracts"
npm ci --no-audit --no-fund
npm run build
VERSION="$(node -p "require('./package.json').version")"
# --@horizon:registry, not --registry: contracts/.npmrc sets a scoped registry for
# @horizon, and a scoped setting wins over the default one. Passing the default here
# would publish to whatever that file points at instead of to this job's registry.
# --force so a re-run of the same job does not fail on an already-published version.
npm publish --@horizon:registry="${REGISTRY}" \
  "--//localhost:${REGISTRY_PORT}/:_authToken=ci" --force >/dev/null
echo "published @horizon/contracts@${VERSION}"

if [[ "${DROP_SOURCE}" == "true" ]]; then
  rm -rf "${ROOT}/contracts"
  echo "removed contracts/ — modules must now resolve the package from the registry"
fi

# Point every subsequent npm invocation in this job at the registry. npm reads
# npm_config_* from the environment, so no .npmrc is rewritten and the committed one —
# which points at a developer's local Verdaccio — stays untouched.
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "npm_config_@horizon:registry=${REGISTRY}" >> "${GITHUB_ENV}"
  echo "registry exported to the rest of the job"
else
  echo "export npm_config_@horizon:registry=${REGISTRY}"
fi
