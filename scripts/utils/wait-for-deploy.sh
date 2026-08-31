#!/usr/bin/env bash
# Wait for the newest Vercel PRODUCTION deployment to finish building, reliably.
#
# Why this exists: `vercel ls` prints its human-readable table to STDERR (stdout carries only the
# bare URLs), so the obvious polling loop — `vercel ls 2>/dev/null | grep Ready` — sees nothing,
# matches nothing, and spins until whatever timeout kills it. An agent burned real minutes on
# exactly that, twice. This script captures both streams, bounds the wait, and exits with a code
# you can branch on.
#
# Usage:
#   ./scripts/utils/wait-for-deploy.sh                     # wait up to 10 min for newest prod deploy
#   ./scripts/utils/wait-for-deploy.sh --timeout 300       # custom bound (seconds)
#   ./scripts/utils/wait-for-deploy.sh --sha <commit>      # also require the deploy to be for <commit>
#
# Exit codes: 0 = Ready · 1 = deploy failed (Error/Canceled) · 2 = timed out · 3 = usage/CLI error
#
# --sha matches against `vercel inspect`'s reported commit when available. If the CLI output
# carries no commit metadata the script says so and falls back to "newest production deployment"
# rather than guessing.
set -euo pipefail

TIMEOUT=600
SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "wait-for-deploy: unknown arg $1" >&2; exit 3 ;;
  esac
done

POLL=15
START=$(date +%s)
LAST_URL=""

while true; do
  ELAPSED=$(( $(date +%s) - START ))
  if (( ELAPSED >= TIMEOUT )); then
    echo "wait-for-deploy: timed out after ${TIMEOUT}s (last seen: ${LAST_URL:-none})" >&2
    exit 2
  fi

  # ⚠️ 2>&1 is load-bearing — the table is on stderr.
  ROW=$(npx vercel ls --yes 2>&1 | grep -E "Production" | head -1 || true)
  URL=$(echo "$ROW" | grep -oE 'https://[^ ]+' | head -1 || true)
  STATUS=$(echo "$ROW" | grep -oE 'Building|Queued|Ready|Error|Canceled' | head -1 || true)

  if [[ -z "$URL" || -z "$STATUS" ]]; then
    echo "[${ELAPSED}s] no production deployment row parsed yet" >&2
    sleep "$POLL"
    continue
  fi
  LAST_URL="$URL"

  if [[ -n "$SHA" ]]; then
    # Best-effort commit match; vercel inspect prints to stderr too.
    INSPECT=$(npx vercel inspect "$URL" 2>&1 || true)
    if echo "$INSPECT" | grep -qiE 'commit|sha'; then
      if ! echo "$INSPECT" | grep -q "${SHA:0:7}"; then
        echo "[${ELAPSED}s] newest prod deploy $URL is not for ${SHA:0:7} yet ($STATUS)" >&2
        sleep "$POLL"
        continue
      fi
    else
      echo "wait-for-deploy: CLI output carries no commit metadata; matching newest deploy only" >&2
      SHA="" # say it once, then stop re-inspecting every poll
    fi
  fi

  case "$STATUS" in
    Ready)
      echo "$URL"
      echo "wait-for-deploy: Ready after ${ELAPSED}s" >&2
      exit 0 ;;
    Error|Canceled)
      echo "wait-for-deploy: deployment $STATUS — $URL" >&2
      exit 1 ;;
    *)
      echo "[${ELAPSED}s] $STATUS — $URL" >&2
      sleep "$POLL" ;;
  esac
done
