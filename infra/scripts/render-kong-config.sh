#!/usr/bin/env bash
#
# Render the runnable Kong configuration from the committed template plus the current
# Ed25519 public keys.
#
# WHY THIS EXISTS. Kong OSS verifies EdDSA (RFC 8037) in its `jwt` plugin — verified
# against the plugin source in kong:3.9 — but it has no plugin that fetches a JWKS
# document; `openid-connect` is Enterprise-only. So the public key has to be present in
# the declarative configuration.
#
# Rather than commit key material into gateway/kong.yml and hand-edit it on every
# rotation, the committed file stays key-free and this script injects the keys into a
# gitignored generated file. Rotation is: generate a new kid, re-render, reload. In the
# Terraform definition the same script reads from AWS Secrets Manager instead of disk.
#
# The gateway is defence in depth, not the only check: every service re-verifies the
# token itself (TRUST_GATEWAY_JWT=false), so this failing open would not grant access.

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"

TEMPLATE="$ROOT_DIR/gateway/kong.yml"
KEY_DIR="${HORIZON_KEY_DIR:-$INFRA_DIR/keys}"
PUBLIC_KEY_DIR="$KEY_DIR/public"
OUT_DIR="$INFRA_DIR/generated"
OUT="$OUT_DIR/kong.generated.yml"

if [[ ! -d "$PUBLIC_KEY_DIR" ]] || ! compgen -G "$PUBLIC_KEY_DIR/*.pem" >/dev/null; then
  echo "no public keys in $PUBLIC_KEY_DIR — run 'make keys' first" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

{
  echo "# GENERATED — do not edit. Source: gateway/kong.yml + $PUBLIC_KEY_DIR"
  echo "# Regenerate with: make kong-config"
  cat "$TEMPLATE"
  echo
  echo "consumers:"
  echo "  - username: horizon-identity"
  echo "    jwt_secrets:"

  for key_file in "$PUBLIC_KEY_DIR"/*.pem; do
    # ed25519-dev-1-public.pem -> dev-1
    kid="$(basename "$key_file" | sed -E 's/^ed25519-(.*)-public\.pem$/\1/')"
    echo "      # kid: $kid"
    echo "      - key: horizon-identity-$kid"
    echo "        algorithm: EdDSA"
    # Unused for asymmetric algorithms — Kong verifies with rsa_public_key. It is
    # rendered only because deck's schema validation requires the field to be present.
    # Random rather than a fixed placeholder so it can never be mistaken for a shared
    # secret that means something.
    echo "        secret: $(openssl rand -hex 16)"
    echo "        rsa_public_key: |"
    sed 's/^/          /' "$key_file"
  done
} > "$OUT"

echo "rendered $OUT"
echo "  keys: $(find "$PUBLIC_KEY_DIR" -name '*.pem' | wc -l)"

if command -v deck >/dev/null 2>&1; then
  deck file validate "$OUT" && echo "  deck: valid"
fi
