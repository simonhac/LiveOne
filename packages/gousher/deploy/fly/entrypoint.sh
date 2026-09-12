#!/bin/sh
set -eu
# A fresh Fly volume belongs to root. Only prepare the dedicated mount root;
# application directories and their private files are created by the service user.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  chown 10001:10001 /data
  for cert_file in "${GOUSHER_TLS_CERT_FILE:-}" "${GOUSHER_TLS_KEY_FILE:-}"; do
    if [ -n "$cert_file" ]; then
      chown 10001:10001 "$cert_file"
      chmod 600 "$cert_file"
    fi
  done
  exec su-exec 10001:10001 "$@"
fi
exec "$@"
