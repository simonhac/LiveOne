#!/usr/bin/env bash
#
# Generate the EC (prime256v1 / P-256) keypair Tesla's Fleet API requires for partner
# registration and command signing.
#
#   - PUBLIC key  -> hosted at /.well-known/appspecific/com.tesla.3p.public-key.pem
#                    (set as TESLA_PUBLIC_KEY_PEM)
#   - PRIVATE key -> kept secret (set as TESLA_PRIVATE_KEY_PEM); only used later to
#                    sign commands for non-exempt (2021+) vehicles.
#
# Usage:  ./scripts/utils/tesla-generate-keypair.sh [output-dir]
# Writes tesla-private-key.pem + tesla-public-key.pem to the output dir (default: cwd).
# Do NOT commit the private key.

set -euo pipefail

OUT_DIR="${1:-.}"
PRIV="$OUT_DIR/tesla-private-key.pem"
PUB="$OUT_DIR/tesla-public-key.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$PRIV"
openssl ec -in "$PRIV" -pubout -out "$PUB" 2>/dev/null

echo "Wrote:"
echo "  private: $PRIV  (secret -> TESLA_PRIVATE_KEY_PEM)"
echo "  public:  $PUB   (-> TESLA_PUBLIC_KEY_PEM, served at .well-known)"
echo
echo "To set as single-line env vars (escaped newlines):"
echo "  TESLA_PUBLIC_KEY_PEM=\"\$(awk 'NR>1{printf \"\\\\n\"}{printf \"%s\",\$0}' $PUB)\""
