#!/usr/bin/env bash
#
# Restore drill for the off-site PG backups — proves the latest R2 dump actually restores.
#
# Pulls the newest object under $BACKUP_PREFIX from R2, decompresses (and age-decrypts if the object
# is .age), pg_restores it into a throwaway target, and asserts the restored point_readings row count
# is within tolerance of the live Sydney count — which catches both a truncated dump and a stale/stuck
# backup. Best-effort Slack alert + non-zero exit on failure. The "0 restore errors" leg of 3-2-1-1-0.
# See docs/turso-pg-migration.md → "Off-site backup — provider-independent DR".
#
# Required env:
#   R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   read access to the bucket
#   DRILL_DATABASE_URL        throwaway Postgres to restore into (e.g. the CI postgres:17 service)
#   PG_LIVE_DATABASE_URL      live Sydney branch — read-only, for the expected row count
# Optional env:
#   AGE_IDENTITY              age private key (file path or literal) if backups are encrypted (.age)
#   ALERT_WEBHOOK_URL         Slack-compatible webhook; posted on failure
#   BACKUP_PREFIX             key prefix to scan (default: pg/sydney)
#   MIN_RATIO                 restored/live floor for point_readings (default: 0.95)
#
set -euo pipefail

PREFIX="${BACKUP_PREFIX:-pg/sydney}"
MIN_RATIO="${MIN_RATIO:-0.95}"
ENDPOINT="https://${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"
: "${DRILL_DATABASE_URL:?set DRILL_DATABASE_URL}"
: "${PG_LIVE_DATABASE_URL:?set PG_LIVE_DATABASE_URL}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

notify() {  # best-effort webhook post (Slack-compatible); never fails the run
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"$1\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
}
fail() { echo "ERROR: $1" >&2; notify "🔴 PG restore-drill FAILED: $1"; exit 1; }

command -v rclone     >/dev/null || fail "rclone not found"
command -v pg_restore >/dev/null || fail "pg_restore not found"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"

echo "Finding newest object under r2:${R2_BUCKET}/${PREFIX}/ ..."
KEY="$(rclone lsf --files-only -R "r2:${R2_BUCKET}/${PREFIX}/" --s3-no-check-bucket 2>/dev/null | sort | tail -1 || true)"
[ -n "$KEY" ] || fail "no objects under ${PREFIX}/"
echo "Latest: ${PREFIX}/${KEY}"
rclone copyto "r2:${R2_BUCKET}/${PREFIX}/${KEY}" "$TMP/obj" --s3-no-check-bucket || fail "download failed"

DUMP="$TMP/restore.dump"
case "$KEY" in
  *.age)
    command -v age >/dev/null || fail "object is age-encrypted but 'age' not found"
    [ -n "${AGE_IDENTITY:-}" ] || fail "object is .age but AGE_IDENTITY is unset"
    IDFILE="$TMP/id"; if [ -f "$AGE_IDENTITY" ]; then IDFILE="$AGE_IDENTITY"; else printf '%s' "$AGE_IDENTITY" > "$IDFILE"; fi
    age -d -i "$IDFILE" "$TMP/obj" | gunzip > "$DUMP" || fail "decrypt | gunzip failed" ;;
  *.gz)  gunzip -c "$TMP/obj" > "$DUMP" || fail "gunzip failed" ;;
  *)     cp "$TMP/obj" "$DUMP" ;;
esac

echo "Restoring into the drill target ..."
# pg_restore may emit benign errors (e.g. a CREATE EXTENSION the vanilla image lacks); don't abort on
# them — the row-count assertion below is the real gate.
pg_restore --no-owner --no-privileges --no-comments -j 4 -d "$DRILL_DATABASE_URL" "$DUMP" \
  && echo "pg_restore: clean" || echo "pg_restore: completed with warnings (continuing to row-count check)"

restored() { psql "$DRILL_DATABASE_URL" -tAc "SELECT count(*) FROM $1" 2>/dev/null | tr -d '[:space:]' || true; }
live_est() { psql "$PG_LIVE_DATABASE_URL" -tAc "SELECT n_live_tup FROM pg_stat_user_tables WHERE relname='$1'" 2>/dev/null | tr -d '[:space:]' || true; }

PR_RESTORED="$(restored point_readings)"; PR_LIVE="$(live_est point_readings)"
SS_RESTORED="$(restored sessions)";       AGG_RESTORED="$(restored point_readings_agg_5m)"
echo "Restored: point_readings=${PR_RESTORED:-?} sessions=${SS_RESTORED:-?} agg_5m=${AGG_RESTORED:-?}  (live point_readings≈${PR_LIVE:-?})"

{ [ -n "$PR_RESTORED" ] && [ "$PR_RESTORED" -gt 0 ]; } || fail "restored point_readings is empty/zero"
{ [ -n "$SS_RESTORED" ] && [ "$SS_RESTORED" -gt 0 ]; } || fail "restored sessions is empty/zero"
{ [ -n "$PR_LIVE" ] && [ "$PR_LIVE" -gt 0 ]; } || fail "could not read live point_readings estimate"

# restored should be ≥ MIN_RATIO × live (allows for rows added since the backup; catches truncation/staleness)
awk -v r="$PR_RESTORED" -v l="$PR_LIVE" -v m="$MIN_RATIO" 'BEGIN { exit !(r >= l*m) }' \
  || fail "restored point_readings ${PR_RESTORED} < ${MIN_RATIO}× live ${PR_LIVE} — truncated or stale backup"

echo "✓ Restore drill PASSED: point_readings ${PR_RESTORED} ≥ ${MIN_RATIO}× live ${PR_LIVE} (object ${KEY})"
notify "✅ PG restore-drill OK — point_readings ${PR_RESTORED} (≥${MIN_RATIO}× live ${PR_LIVE}) — ${KEY}"
