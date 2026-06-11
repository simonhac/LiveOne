#!/usr/bin/env bash
#
# Off-site, provider-independent backup of the PlanetScale Sydney Postgres branch.
#
# Dumps with `pg_dump -Fc` (custom format), optionally client-side age-encrypts, and uploads to
# Cloudflare R2 via the S3 API (multipart, so >1 GB is fine). Built to run from GitHub Actions
# (.github/workflows/pg-backup.yml) but runnable locally. Best-effort Slack alert on failure.
#
# This is the PG sibling of scripts/utils/backup-prod-db.sh (which exports Turso to a local file).
# Rationale + design: docs/turso-pg-migration.md → "Off-site backup — provider-independent DR".
#
# Required env:
#   PG_BACKUP_DATABASE_URL   postgres://USER:PW@HOST:5432/DB?sslmode=verify-full
#                            ^ use the DIRECT port 5432 — the 6432 pooler rejects pg_dump/pg_restore
#   R2_ACCOUNT_ID            Cloudflare account id (endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com)
#   R2_BUCKET                target bucket, e.g. liveone-pg-backups
#   R2_ACCESS_KEY_ID         R2 S3 access key id   (scoped: Object Read & Write on this bucket, NO delete)
#   R2_SECRET_ACCESS_KEY     R2 S3 secret
#
# Upload is via rclone's S3 backend talking to R2's S3-compatible endpoint (auto-multipart, so the
# ~1.1 GB dump is fine — `wrangler r2 object put` is capped at 300 MiB and can't do this in one shot).
# Optional env:
#   AGE_RECIPIENT            age public key; if set, the dump is client-side encrypted before upload
#                            (the runner can never decrypt its own backups — keep the identity offline)
#   ALERT_WEBHOOK_URL        Slack-compatible webhook; posted on failure
#   BACKUP_PREFIX            object-key prefix (default: pg/sydney)
#   MIN_BYTES                abort if the dump is smaller than this (default: 104857600 = 100 MB)
#
set -euo pipefail

PREFIX="${BACKUP_PREFIX:-pg/sydney}"
MIN_BYTES="${MIN_BYTES:-104857600}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EXT="dump.gz"; [ -n "${AGE_RECIPIENT:-}" ] && EXT="dump.gz.age"
# GFS tier (UTC): 1st-of-month → monthly, Sunday → weekly, else daily. The bucket's lifecycle rules
# expire each prefix on its own schedule (daily 21d / weekly 70d / monthly 400d).
DOW="$(date -u +%u)"   # 1=Mon .. 7=Sun
DOM="$(date -u +%d)"
if   [ "$DOM" = "01" ]; then TIER=monthly
elif [ "$DOW" = "7"  ]; then TIER=weekly
else                         TIER=daily
fi
KEY="${PREFIX}/${TIER}/liveone-${STAMP}.${EXT}"
ENDPOINT="https://${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${PG_BACKUP_DATABASE_URL:?set PG_BACKUP_DATABASE_URL}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/backup.${EXT}"

alert() {
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"🔴 PG→R2 backup FAILED: $1\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
}
fail() { echo "ERROR: $1" >&2; alert "$1"; exit 1; }

command -v pg_dump >/dev/null || fail "pg_dump not found"
command -v rclone  >/dev/null || fail "rclone not found"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"

# Exclude the platform-managed schema so the dump restores cleanly into a vanilla Postgres in a
# provider-loss scenario (the Sydney cutover excluded the same). pscale_extensions is not user data.
DUMP_FLAGS=(-Fc --no-owner --no-privileges --exclude-schema=pscale_extensions)

echo "Dumping Sydney PG → ${OUT} ..."
if [ -n "${AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || fail "AGE_RECIPIENT set but 'age' not found"
  pg_dump "${DUMP_FLAGS[@]}" "$PG_BACKUP_DATABASE_URL" | gzip -6 | age -r "$AGE_RECIPIENT" > "$OUT" \
    || fail "pg_dump | gzip | age pipeline failed"
else
  pg_dump "${DUMP_FLAGS[@]}" "$PG_BACKUP_DATABASE_URL" | gzip -6 > "$OUT" \
    || fail "pg_dump | gzip pipeline failed"
fi

SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
echo "Dump size: $(( SIZE / 1024 / 1024 )) MB"
[ "$SIZE" -ge "$MIN_BYTES" ] || fail "dump suspiciously small (${SIZE} bytes < ${MIN_BYTES}) — not uploading"

echo "Uploading → r2://${R2_BUCKET}/${KEY}"
# Configure an ephemeral rclone S3 remote ("r2") purely from env — no rclone.conf on disk.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"
# Don't set an ACL — R2 doesn't support S3 ACLs and returns NotImplemented (rclone then retries
# without it). The rclone "Cloudflare" provider already omits the unsupported headers.
rclone copyto "$OUT" "r2:${R2_BUCKET}/${KEY}" --s3-no-check-bucket --stats-one-line \
  || fail "R2 upload failed"

echo "✓ Backup complete: r2://${R2_BUCKET}/${KEY} (${SIZE} bytes)"
