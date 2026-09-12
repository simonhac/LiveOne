#!/bin/sh
set -eu
# A fresh Fly volume belongs to root. Only prepare the dedicated mount root;
# application directories and their private files are created by the service user.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  chown 10001:10001 /data
  for cert_file in "${GOUSHER_TLS_CERT_FILE:-}" "${GOUSHER_TLS_KEY_FILE:-}" "${GOUSHER_SSH_KEY_FILE:-}"; do
    if [ -n "$cert_file" ]; then
      chown 10001:10001 "$cert_file"
      chmod 600 "$cert_file"
    fi
  done
  exec su-exec 10001:10001 /usr/local/bin/trial-entrypoint "$@"
fi
if [ -n "${GOUSHER_HUB_HOST:-}" ]; then
  : "${GOUSHER_SSH_KEY_FILE:?SSH key required}"
  : "${GOUSHER_SSH_KNOWN_HOSTS_FILE:?Pinned host key required}"
  (
    while :; do
      ssh -N -T -p 2222 -i "$GOUSHER_SSH_KEY_FILE" \
        -o BatchMode=yes -o StrictHostKeyChecking=yes \
        -o UserKnownHostsFile="$GOUSHER_SSH_KNOWN_HOSTS_FILE" \
        -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
        -L 127.0.0.1:18080:10.0.1.190:80 -L 127.0.0.1:18081:10.0.1.191:80 \
        "trial-forward@$GOUSHER_HUB_HOST" || true
      sleep 5
    done
  ) &
fi
exec "$@"
