# Plan: stop `psql` failing on SSL every session

Status: proposed (2026-07-22). To be executed in a separate workspace.

## Context

Across the config-v4 execution phases, agents keep hitting the same wall:
`psql "$PLANETSCALE_DATABASE_URL"` fails on SSL, so the fallback is to hand-roll a throwaway `tsx`
script that uses the app's `planetscaleDb` pool. That workaround is slow, non-reusable, and gets
reinvented every phase. This plan removes the friction at the source.

## Diagnosis (verified, not theory)

- The connection URL in `.env.local` carries **`?sslmode=verify-full`** and **no `sslrootcert`**.
- With `verify-full` and no cert, **libpq** looks for a root CA at `~/.postgresql/root.crt`, which
  does not exist on the dev Mac, and aborts:
  `root certificate file "…/.postgresql/root.crt" does not exist … use the system's trusted roots
  with sslrootcert=system, or change sslmode`.
- **Node's `pg` driver works** because it does NOT use libpq — `getPoolConfig()`
  (`lib/db/planetscale/index.ts:37-64`) strips every ssl param from the URL and applies
  `ssl: { rejectUnauthorized: false }` (encrypt, don't verify CA) using Node's built-in Mozilla CA
  bundle. drizzle-kit sidesteps it the same way (`drizzle-planetscale.config.ts:22-52`, discrete fields).
- Local toolchain is **psql/libpq 18.1** (not old), and `sslrootcert=system` is a libpq 16+ feature —
  so the "old client" theory is wrong; the trigger is purely the missing on-disk CA.
- **Proven fix:** `PGSSLROOTCERT=system psql "$PLANETSCALE_DATABASE_URL" -c 'select 1'` connects
  instantly (verified against the Sydney branch, PG 17.10). libpq resolves `system` to the OpenSSL
  default store (`OPENSSLDIR`, `/usr/local/etc/openssl@3/cert.pem` on this Mac).

Note: the repo's code comments and `getPoolConfig` also strip `sslrootcert=system` because *earlier*
minted URLs carried that param (which node-pg can't parse — it `open('system')`s it as a file). psql
18 handles both URL shapes, so `PGSSLROOTCERT=system` is robust to either form.

## Why this keeps happening

`CLAUDE.md` (the "Connect with psql" snippet) documents the failing command
(`psql "$PLANETSCALE_DATABASE_URL"`) with no SSL caveat, so every fresh session/agent is sent down the
broken path and improvises a workaround.

## Changes

**1. Committed `npm run db:psql` wrapper** — `scripts/utils/psql.sh` (`chmod +x`). The durable,
portable fix: works in a fresh clone/CI without any machine-level change, and self-documents in
`package.json`. Behavior:
- Resolve the repo root from the script's own dir; read the target URL from `.env.local`
  (var defaults to `PLANETSCALE_DATABASE_URL`; overridable via `DB_URL_VAR=…`, or a full `PSQL_URL=…`
  for a minted Sydney `pscale role` URL). Extract with a quote-tolerant `grep|sed`, not `source`.
- Decompose the URL into `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` — the `pgEnv()` pattern from
  `scripts/seed-preview-db.ts:41-56` — so the password travels via env, never argv / the process list.
- Set `PGSSLMODE=verify-full` + `PGSSLROOTCERT=system` (an upgrade over pgEnv's `require`: local libpq
  is 18, so keep real CA verification instead of encrypt-without-verify).
- `exec psql "$@"`, so `npm run db:psql -- -c "select now()"` and `-f file.sql` pass straight through.
- Add `"db:psql": "scripts/utils/psql.sh"` to `package.json` scripts.

**2. Machine fix — make bare `psql` just work on the dev Mac.** Add one line to `~/.zshrc`:
`export PGSSLROOTCERT=system`. Then `psql "$PLANETSCALE_DATABASE_URL"` (and any script that shells to
psql — `seed-preview-db.ts`, `restore-drill-pg.sh`) verifies correctly with zero per-command flags,
across every Conductor workspace on the machine. Harmless globally — `PGSSLROOTCERT` only takes effect
when a connection actually requests verification. (Equivalent alternative if a shell edit is unwanted:
symlink `~/.postgresql/root.crt -> /etc/ssl/cert.pem`; the env var is simpler/path-independent.)
This step is machine-local (not committed) — do it once per dev machine.

**3. Fix the misleading docs.** Update the `CLAUDE.md` "Connect with psql" snippet (which currently
sends every session down the failing path): show `npm run db:psql -- -c "…"` as the primary path, with
a one-line why (`verify-full` needs a CA source; the wrapper sets `PGSSLROOTCERT=system`).

**4. Update agent memory** so future sessions recall the fix without rediscovering it. Add a small
memory file (e.g. `psql-ssl-verify-full.md`): "psql to PlanetScale fails: `verify-full` + no on-disk
CA → use `npm run db:psql` / `PGSSLROOTCERT=system`; Node works because `getPoolConfig` strips ssl
params" — plus its one-line pointer in `MEMORY.md`, cross-linked to the existing
`admin-api-curl-blocked-by-clerk-middleware` note (which already covers the node-pg conn-param gotcha).

Not recommended: editing the connection URL itself — it's 1Password-templated
(`op inject -i .env.tpl -o .env.local`), so it means touching `.env.tpl` + the vault and re-injecting
on every machine; higher blast radius on a guarded credential path.

## Verification

- Baseline (already confirmed): `PGSSLROOTCERT=system psql "$PLANETSCALE_DATABASE_URL" -tAc "select 1"`
  prints `1`.
- Wrapper: `npm run db:psql -- -tAc "select now()"` returns a timestamp; `npm run db:psql -- -c "\dt"`
  lists tables. `ps` during the run shows no password in the psql args.
- Sydney override: mint a role URL (`pscale role create liveone sydney … --format json`) and
  `PSQL_URL="<that url>" npm run db:psql -- -tAc "select 1"` connects to prod.
- Machine fix: after adding the `~/.zshrc` line and opening a new shell, bare
  `psql "$PLANETSCALE_DATABASE_URL" -tAc "select 1"` works with no flag.
- Docs/memory: `CLAUDE.md` psql section shows `npm run db:psql`; `MEMORY.md` has the new pointer line.
