#!/usr/bin/env bash
#
# Generate Ed25519 development keys for identity/ (ADR 0018).
#
# Output goes to a gitignored path. Key material is NEVER committed: .gitignore covers
# *.pem and *.key, infra/keys/, and a Gitleaks job runs in CI. In the Terraform
# definition these come from AWS Secrets Manager instead.

set -euo pipefail

KEY_DIR="${HORIZON_KEY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/keys}"
KID="${1:-dev-1}"

mkdir -p "$KEY_DIR/public"

PRIVATE="$KEY_DIR/ed25519-$KID-private.pem"
PUBLIC="$KEY_DIR/public/ed25519-$KID-public.pem"

if [[ -f "$PRIVATE" ]]; then
  echo "key '$KID' already exists at $PRIVATE — refusing to overwrite" >&2
  exit 1
fi

openssl genpkey -algorithm ed25519 -out "$PRIVATE"
openssl pkey -in "$PRIVATE" -pubout -out "$PUBLIC"
chmod 600 "$PRIVATE"

# A blind index key, so encrypted personal columns stay searchable by exact match
# without being decryptable (ADR 0026).
BLIND_INDEX="$KEY_DIR/blind-index.key"
if [[ ! -f "$BLIND_INDEX" ]]; then
  openssl rand -hex 32 > "$BLIND_INDEX"
  chmod 600 "$BLIND_INDEX"
fi

cat <<EOF

Generated development keys (kid: $KID)

  private       $PRIVATE
  public        $PUBLIC
  blind index   $BLIND_INDEX

Point identity/.env at them:

  JWT_PRIVATE_KEY_PATH=$PRIVATE
  JWT_PUBLIC_KEYS_DIR=$KEY_DIR/public
  JWT_ACTIVE_KID=$KID
  BLIND_INDEX_KEY_PATH=$BLIND_INDEX

To rotate, generate a second kid and keep both public keys in place for longer than the
maximum access-token lifetime before removing the old one.
EOF
