#!/usr/bin/env bash
# Connect to the project's Postgres (PlanetScale) with a working TLS config.
#
# Bare `psql "$PLANETSCALE_DATABASE_URL"` fails: the URL is sslmode=verify-full with no on-disk root
# CA, so libpq aborts looking for ~/.postgresql/root.crt. Here we verify against the system trust
# store (PGSSLROOTCERT=system) and pass the password via env, never argv.
#
# Node's `pg` never hits this — getPoolConfig() (lib/db/planetscale/index.ts) strips the ssl params
# and uses Node's bundled CA store. This wrapper is the equivalent for the psql/libpq CLI.
#
# Usage:
#   npm run db:psql -- -c "select now()"
#   npm run db:psql -- -f query.sql
#   DB_URL_VAR=PLANETSCALE_DATABASE_URL_MIGRATIONS npm run db:psql -- -c "\dt"
#   PSQL_URL="postgres://…sydney…" npm run db:psql -- -tAc "select 1"     # prod override
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Resolve the target connection URL: an explicit PSQL_URL wins; otherwise read the named var
# (default PLANETSCALE_DATABASE_URL) out of .env.local with a quote-tolerant grep|sed.
URL="${PSQL_URL:-}"
if [[ -z "$URL" ]]; then
  VAR="${DB_URL_VAR:-PLANETSCALE_DATABASE_URL}"
  ENV_FILE="$REPO_ROOT/.env.local"
  [[ -f "$ENV_FILE" ]] || { echo "db:psql: $ENV_FILE not found" >&2; exit 1; }
  URL="$(grep -E "^${VAR}=" "$ENV_FILE" | head -1 | sed -E 's/^[^=]+=//; s/^["'"'"']//; s/["'"'"']$//')"
  [[ -n "$URL" ]] || { echo "db:psql: $VAR not set in $ENV_FILE" >&2; exit 1; }
fi

# Decompose the URL into PG* env vars (mirrors pgEnv() in scripts/seed-preview-db.ts), using Node's
# URL parser + percent-decoding. NUL-delimited so passwords with any special chars survive; no eval,
# so nothing is interpreted by the shell.
{ IFS= read -r -d '' PGHOST
  IFS= read -r -d '' PGPORT
  IFS= read -r -d '' PGUSER
  IFS= read -r -d '' PGPASSWORD
  IFS= read -r -d '' PGDATABASE
} < <(URL="$URL" node -e '
  const u = new URL(process.env.URL), dec = decodeURIComponent;
  process.stdout.write([u.hostname, u.port || "5432", dec(u.username), dec(u.password),
    dec(u.pathname.replace(/^\//, "")) || "postgres"].join("\0") + "\0");
')
[[ -n "$PGHOST" ]] || { echo "db:psql: could not parse connection URL" >&2; exit 1; }

export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
export PGSSLMODE=verify-full
export PGSSLROOTCERT=system
exec psql "$@"
