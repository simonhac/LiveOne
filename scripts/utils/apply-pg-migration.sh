#!/usr/bin/env bash
# Apply pending Postgres migrations to a PlanetScale branch WITHOUT leaving objects owned by a
# temporary role.
#
# ## The trap this exists to close
#
# Prod (`sydney`) has no stored connection string, so applying a migration there means minting a
# short-TTL `pscale role`. Postgres makes the CREATING role the OWNER of everything it creates —
# so a migration applied that way leaves its new tables, indexes and sequences owned by a role that
# is about to be deleted. Two things then go wrong, both of them LATER and both of them quiet:
#
#   1. The app connects as `postgres` and gets "permission denied" on the new table — not at apply
#      time, but whenever the dependent code finally ships.
#   2. `pscale role delete` REFUSES while the role owns objects, so the role lingers and its TTL
#      delete fails the same way, every time, forever.
#
# The fix is `pscale role reassign … --successor postgres` — and the whole problem is that it is a
# separate step a human has to remember after a migration that has already "succeeded". Here it is
# an EXIT trap: it runs whether the migration passed, failed, or the terminal was closed.
#
# 🛑 **Do NOT reach for `pscale role reset-default`.** It is the other documented way to get
# `postgres` credentials and on prod it is an OUTAGE: it ROTATES the password, every connection
# using `postgres` breaks, and Vercel captures env at BUILD time — so recovering needs the env
# updated AND a redeploy. Minting a temp role costs nothing and breaks nothing.
#
# ## Usage
#
#   scripts/utils/apply-pg-migration.sh                      # REPORT only: target, pending, ownership
#   scripts/utils/apply-pg-migration.sh --apply              # apply, then reassign + clean up
#   scripts/utils/apply-pg-migration.sh --branch dev-x       # a branch other than prod
#   scripts/utils/apply-pg-migration.sh --audit              # ownership sweep alone (no migrate)
#
# Dry-run by default, matching every other writer in this repo. Off a terminal, `--apply` also
# requires `--yes`.
#
# Exit codes: 0 ok · 1 findings (ownership debt / pending migrations in report mode) · 2 usage ·
# 3 auth/guard refusal · 5 upstream (pscale/psql/migrate failed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DATABASE="liveone"
BRANCH="sydney"
TTL="1h"
APPLY=0
ASSUME_YES=0
AUDIT_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)    APPLY=1; shift ;;
    --audit)    AUDIT_ONLY=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --branch)   BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --database) DATABASE="${2:?--database needs a value}"; shift 2 ;;
    --role-ttl) TTL="${2:?--role-ttl needs a value}"; shift 2 ;;
    -h|--help)  sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          echo "apply-pg-migration: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

command -v pscale >/dev/null || { echo "apply-pg-migration: pscale not on PATH" >&2; exit 5; }
command -v node   >/dev/null || { echo "apply-pg-migration: node not on PATH" >&2; exit 5; }

# ── The ownership sweep. `public` is the only schema a migration writes; `drizzle` holds the
#    journal and is created once. Sequences and indexes are included deliberately: a CREATE TABLE
#    with a serial or a PK creates all three, and they are owned independently.
read -r -d '' OWNERSHIP_SQL <<'SQL' || true
SELECT c.relkind || ' ' || c.relname || ' -> ' || pg_get_userbyid(c.relowner)
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind IN ('r','p','i','S','v','m')
  AND pg_get_userbyid(c.relowner) <> 'postgres'
UNION ALL
SELECT 'f ' || p.proname || ' -> ' || pg_get_userbyid(p.proowner)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND pg_get_userbyid(p.proowner) <> 'postgres'
ORDER BY 1;
SQL

psql_q() { PSQL_URL="$1" "$SCRIPT_DIR/psql.sh" -tAc "$2"; }

# ── Mint the DDL role. `--inherited-roles postgres` gives it the privileges; it does NOT make
#    postgres the owner of what it creates. That is the whole trap, in one sentence.
ROLE_NAME="m$(date +%Y%m%d%H%M%S)"
echo "apply-pg-migration: minting a ${TTL} DDL role on ${DATABASE}/${BRANCH}…" >&2
ROLE_JSON="$(pscale role create "$DATABASE" "$BRANCH" "$ROLE_NAME" \
  --inherited-roles postgres --ttl "$TTL" --format json 2>/dev/null)" \
  || { echo "apply-pg-migration: pscale role create failed" >&2; exit 5; }

eval "$(ROLE_JSON="$ROLE_JSON" node -e '
  const r = JSON.parse(process.env.ROLE_JSON);
  const q = (s) => "'"'"'" + String(s).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
  process.stdout.write(
    `ROLE_ID=${q(r.id)}\nROLE_USER=${q(r.username)}\nROLE_HOST=${q(r.access_host_url)}\nDDL_URL=${q(r.database_url)}\n`,
  );
')"

# ── Cleanup, unconditionally. This is the point of the script: reassign runs on EVERY exit path —
#    success, a failed migration, a guard refusal, Ctrl-C. `reassign` is a no-op when the role owns
#    nothing, so it is always safe to run; `delete` is what would otherwise fail.
cleanup() {
  local rc=$?
  echo "apply-pg-migration: reassigning any objects owned by ${ROLE_ID} to postgres…" >&2
  pscale role reassign "$DATABASE" "$BRANCH" "$ROLE_ID" --successor postgres --force >/dev/null 2>&1 \
    || echo "apply-pg-migration: ⚠️  reassign FAILED — run it by hand before the role is deleted:
    pscale role reassign $DATABASE $BRANCH $ROLE_ID --successor postgres --force" >&2
  pscale role delete "$DATABASE" "$BRANCH" "$ROLE_ID" --force >/dev/null 2>&1 \
    || echo "apply-pg-migration: ⚠️  role ${ROLE_ID} could NOT be deleted — it still owns objects.
    That is the trap: sweep with --audit, reassign, then delete." >&2
  exit $rc
}
trap cleanup EXIT INT TERM

# ── The guard, on the CONNECTION USERNAME. PlanetScale puts every branch in a region on ONE gateway
#    host and tells them apart by the username suffix (`postgres.<branch-id>`), so the hostname
#    proves nothing. Inside Postgres, `current_user` has that suffix STRIPPED — so a server-side
#    check false-negatives. The URL's username is the only place the branch id is legible.
PROD_BRANCH_ID="$(grep -E '^PLANETSCALE_PROD_BRANCH_ID=' "$REPO_ROOT/.env.local" 2>/dev/null \
  | head -1 | sed -E 's/^[^=]+=//; s/^["'"'"']//; s/["'"'"']$//')" || true
if [[ -z "$PROD_BRANCH_ID" ]]; then
  echo "apply-pg-migration: PLANETSCALE_PROD_BRANCH_ID is not set in .env.local — refusing, because
  without it this script cannot tell prod from dev and the banner below would be a guess." >&2
  exit 3
fi

IS_PROD=0
[[ "$ROLE_USER" == *"$PROD_BRANCH_ID"* ]] && IS_PROD=1

cat >&2 <<BANNER

  target:   ${DATABASE}/${BRANCH}   $( ((IS_PROD)) && echo '🛑 PRODUCTION' || echo '(non-prod)' )
  user:     ${ROLE_USER}
  host:     ${ROLE_HOST}
  role:     ${ROLE_ID} (ttl ${TTL}, deleted on exit)

BANNER

if ((IS_PROD)) && [[ "$BRANCH" != "sydney" ]]; then
  echo "apply-pg-migration: branch '${BRANCH}' carries the PROD branch id — refusing (fail-closed)." >&2
  exit 3
fi
if ((!IS_PROD)) && [[ "$BRANCH" == "sydney" ]]; then
  echo "apply-pg-migration: asked for 'sydney' but the connection does NOT carry the prod branch id.
  Either PLANETSCALE_PROD_BRANCH_ID is stale or this is not the branch you think it is." >&2
  exit 3
fi

# ── Pre-state, so the post-audit reports what THIS run caused rather than what it inherited.
PRE_OWNED="$(psql_q "$DDL_URL" "$OWNERSHIP_SQL" || true)"
if [[ -n "$PRE_OWNED" ]]; then
  echo "apply-pg-migration: ⚠️  PRE-EXISTING ownership debt on ${BRANCH} — the app connects as
  postgres and will get 'permission denied' on each of these:" >&2
  echo "$PRE_OWNED" | sed 's/^/    /' >&2
  echo >&2
fi

if ((AUDIT_ONLY)); then
  if [[ -n "$PRE_OWNED" ]]; then exit 1; fi
  echo "apply-pg-migration: ✓ ownership clean — every object in public is owned by postgres." >&2
  exit 0
fi

# ── What is pending. drizzle records a HASH, not a name, so match the journal against the files.
PENDING="$(DDL_URL="$DDL_URL" node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const dir = path.join(process.cwd(), "drizzle-planetscale");
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
  const hashes = journal.entries.map((e) => ({
    tag: e.tag,
    hash: crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(dir, e.tag + ".sql"), "utf8")).digest("hex"),
  }));
  process.stdout.write(JSON.stringify(hashes));
' 2>/dev/null || echo '[]')"

APPLIED="$(psql_q "$DDL_URL" "SELECT hash FROM drizzle.__drizzle_migrations" 2>/dev/null || true)"
PENDING_TAGS="$(PENDING="$PENDING" APPLIED="$APPLIED" node -e '
  const pend = JSON.parse(process.env.PENDING || "[]");
  const applied = new Set((process.env.APPLIED || "").split("\n").map((s) => s.trim()).filter(Boolean));
  process.stdout.write(pend.filter((p) => !applied.has(p.hash)).map((p) => p.tag).join("\n"));
')"

if [[ -z "$PENDING_TAGS" ]]; then
  echo "apply-pg-migration: nothing pending on ${BRANCH} — already up to date." >&2
  [[ -n "$PRE_OWNED" ]] && exit 1
  exit 0
fi

echo "apply-pg-migration: pending on ${BRANCH}:" >&2
echo "$PENDING_TAGS" | sed 's/^/    /' >&2
echo >&2

if ((!APPLY)); then
  echo "apply-pg-migration: report only. Re-run with --apply to apply the above." >&2
  exit 1
fi

if ((!ASSUME_YES)) && [[ ! -t 0 ]]; then
  echo "apply-pg-migration: --apply off a terminal also requires --yes." >&2
  exit 2
fi
if ((IS_PROD)) && ((!ASSUME_YES)) && [[ -t 0 ]]; then
  read -r -p "Apply the above to 🛑 PRODUCTION (${DATABASE}/${BRANCH})? [y/N] " reply
  [[ "$reply" == [yY]* ]] || { echo "apply-pg-migration: aborted." >&2; exit 0; }
fi

# ── Apply. drizzle-kit runs the whole file in ONE transaction, so a failed gate rolls back
#    everything and records nothing — which is why the cleanup trap is safe on the failure path too.
echo "apply-pg-migration: applying…" >&2
PLANETSCALE_DATABASE_URL_MIGRATIONS="$DDL_URL" \
  npm --prefix "$REPO_ROOT" run db:pg:migrate 2>&1 | tail -5 \
  || { echo "apply-pg-migration: db:pg:migrate FAILED — nothing was recorded." >&2; exit 5; }

# ── 🛑 The reassign happens in the EXIT trap, so it has NOT run yet. Do it here too, before the
#    post-audit, or the audit would report every object this run just created as debt.
pscale role reassign "$DATABASE" "$BRANCH" "$ROLE_ID" --successor postgres --force >/dev/null 2>&1 \
  || { echo "apply-pg-migration: reassign failed — see the trap's message below." >&2; exit 5; }

# ── Verify the CATALOG, not the migrator's word for it. A migration that silently did nothing looks
#    exactly like one that worked.
POST_OWNED="$(psql_q "$DDL_URL" "$OWNERSHIP_SQL" || true)"
LAST="$(psql_q "$DDL_URL" "SELECT max(id)::text || ' ' || (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1) FROM drizzle.__drizzle_migrations" || true)"

echo >&2
if [[ -n "$POST_OWNED" ]]; then
  echo "apply-pg-migration: ⚠️  objects are STILL not owned by postgres after the reassign:" >&2
  echo "$POST_OWNED" | sed 's/^/    /' >&2
  exit 1
fi
echo "apply-pg-migration: ✓ applied, and every object in public is owned by postgres." >&2
echo "apply-pg-migration:   journal now at: ${LAST}" >&2
echo "apply-pg-migration:   🛑 verify the shape you expected actually landed — the catalog, by name." >&2
