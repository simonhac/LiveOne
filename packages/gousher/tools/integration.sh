#!/usr/bin/env bash
# Private PostgreSQL cluster; no shared development or production services.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ -z "${PG_BINDIR:-}" ]]; then
  for candidate in /usr/local/opt/postgresql@18/bin /opt/homebrew/opt/postgresql@18/bin /usr/lib/postgresql/18/bin /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin; do
    if [[ -x "$candidate/postgres" ]]; then PG_BINDIR="$candidate"; break; fi
  done
fi
: "${PG_BINDIR:?Set PG_BINDIR to a directory containing postgres, initdb and pg_ctl}"
mkdir -p .context
trial_dir=$(mktemp -d "$PWD/.context/gousher-integration.XXXXXX")
trial_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export PGSSLMODE=disable
unset PGSSLROOTCERT PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE
cleanup() { "$PG_BINDIR/pg_ctl" -D "$trial_dir/postgres" -m fast stop > /dev/null 2>&1 || true; }
trap cleanup EXIT
"$PG_BINDIR/initdb" -D "$trial_dir/postgres" -A trust --no-locale -E UTF8 > "$trial_dir/initdb.log"
"$PG_BINDIR/pg_ctl" -D "$trial_dir/postgres" -l "$trial_dir/postgres.log" -o "-h 127.0.0.1 -p $trial_port -k /tmp" start
"$PG_BINDIR/createdb" -h 127.0.0.1 -p "$trial_port" gousher_test
export GOUSHER_TEST_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:$trial_port/gousher_test?sslmode=disable"
export GOUSHER_REPLAY_DIR="$trial_dir"
cat > "$trial_dir/drizzle.config.ts" <<CONFIG
export default {schema:'$PWD/lib/db/planetscale/schema.ts', out:'$trial_dir/schema', dialect:'postgresql'};
CONFIG
npx drizzle-kit generate --config "$trial_dir/drizzle.config.ts" > "$trial_dir/generate.log"
mv "$trial_dir/drizzle.config.ts" "$trial_dir/drizzle.config.ts.txt"
# A clean snapshot must create unique indexes before adding FKs that reference
# them. This ordering is only for disposable setup; the real migration follows.
python3 - "$trial_dir" <<'PY'
import glob, sys
root=sys.argv[1]
parts=open(glob.glob(root+'/schema/*.sql')[0]).read().split('--> statement-breakpoint')
parts.sort(key=lambda s: 2 if s.lstrip().startswith('ALTER TABLE') else 1 if s.lstrip().startswith(('CREATE UNIQUE INDEX','CREATE INDEX')) else 0)
open(root+'/schema.sql','w').write('\n'.join(parts))
PY
"$PG_BINDIR/psql" "$GOUSHER_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$trial_dir/schema.sql" > "$trial_dir/schema.log"
"$PG_BINDIR/psql" "$GOUSHER_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP TABLE managed_pollers; DROP TABLE collectors;' > /dev/null
"$PG_BINDIR/psql" "$GOUSHER_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-planetscale/0067_gousher_managed_pollers.sql > "$trial_dir/migration.log"
(cd packages/gousher
 for vendor in deepsea fronius selectronic sigenergy; do
  go run ./cmd/gousher -replay "internal/gousher/testdata/$vendor.jsonl" -replay-batches "$trial_dir/$vendor.jsonl"
 done)
npm run test:integration -- --runInBand --setupFiles ./packages/gousher/tools/integration-setup.cjs --runTestsByPath lib/collectors/__tests__/gousher.integration.test.ts
