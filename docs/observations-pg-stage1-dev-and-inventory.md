# Stage 1: dev Postgres wiring + Turso read-site inventory

Supporting notes for the Postgres-primary migration (Stage 1, PR-6). Two parts:
(A) how dev connects to Postgres safely, and (B) a first-pass inventory of every
Turso read/write site, classified to scope the Stage 2 cutover PRs.

## A. Dev Postgres wiring (shared PlanetScale dev branch)

Decision C: dev uses a **shared PlanetScale dev branch** (not a separate engine), with
Postgres PITR as the safety backstop. To keep that safe:

### Env (`.env.local`)

- `PLANETSCALE_DATABASE_URL` → the **dev branch** connection string (runtime client).
- `PLANETSCALE_DATABASE_URL_MIGRATIONS` (or `DB_*`) → DDL creds for `db:pg:migrate`.
- `PLANETSCALE_PRODUCTION_HOST` → the production branch host (a hostname, **not** a
  credential). Setting this **arms the guardrail** below.
- `PLANETSCALE_POOL_MAX` (optional) → per-instance pool cap (default 10).

### Guardrail (PR-1/PR-6, `lib/db/planetscale/index.ts`)

`assertNotProdDbInDev()` runs when `getPool()` resolves a config outside production. If the
resolved host matches `PLANETSCALE_PRODUCTION_HOST`, it **throws** — preventing a dev process
from reading/writing the production database. It is **inert until `PLANETSCALE_PRODUCTION_HOST`
is set**, and `ALLOW_PROD_DB_IN_DEV=true` is an explicit one-off escape hatch (e.g. for a
read-only prod seed/reconcile run). Combined with PlanetScale PITR, this covers the
"dev too similar to prod" risk.

### `receive-dev`

`app/api/observations/receive-dev/route.ts` currently **only logs** (no PG writes), so the dev
queue pipeline doesn't populate dev Postgres today. To exercise the PG ingest path in dev,
either point the publisher's receiver URL at a reachable dev receiver that writes the dev
branch, or extend `receive-dev` to write (guarded by the dev-branch guardrail above).
**Follow-up — not changed in Stage 1** to keep this PR additive/no-behaviour-change.

### PITR backups (PR-2 ops, dashboard)

Set a long-retention custom backup **schedule** + **prevent-deletion** once in the PlanetScale
dashboard (no documented CLI/API for the schedule). Optionally script periodic
`pscale backup create` for belt-and-braces.

## B. Turso read/write-site inventory

Generated from importers of `@/lib/db/turso*` (46 files; docs/CLAUDE.md excluded). This is a
**first-pass scoping checklist** — the exact tables each file touches are confirmed during the
relevant Stage 2 PR. Classes: **Config** (Class 1 → PG-authoritative), **Readings** (Class 2 →
PG read/compute), **Mixed**, **Ops/Vendor/Script/Test**.

### Config accessors & write sites → PR-7/PR-8/PR-9/PR-10

- `lib/systems-manager.ts` — systems ⋈ polling_status read accessor + `createSystem` (port:
  reads PR-8, writes PR-9).
- `lib/polling-utils.ts` — polling_status read/write (PR-9; atomic increment + log-not-throw).
- `lib/share-tokens.ts` — share_tokens read/validate/write (PR-9; PG error code `23505`).
- `lib/user-preferences.ts` — users / default-system + `userHasSystemAccess` (PR-8 read, PR-9
  write). _(Imports `db` indirectly; included per plan.)_
- `app/api/setup/route.ts` — systems + user_systems grants (PR-9).
- `app/api/admin/systems/[systemId]/admin-settings/route.ts` — systems owner + user_systems (PR-9).
- `app/api/admin/systems/[systemId]/settings/route.ts` — system settings (PR-9).
- `app/api/admin/systems/[systemId]/status/route.ts` — polling_status/system status (PR-8/9).
- `app/api/admin/systems/[systemId]/composite-config/route.ts` — composite/system config (PR-9).
- `app/api/admin/users/route.ts`, `app/api/admin/user/[userId]/points/route.ts` — users/point_info.
- `app/api/systems/route.ts` — systems list (PR-8 read).
- `app/api/auth/{enphase,tesla}/{callback,disconnect}/route.ts` — vendor creds on `systems` (PR-9).
- `app/api/admin/sessions/filter-options/route.ts` — sessions metadata (read; PR-12-ish).

### Readings reads & aggregation compute → PR-11/PR-12

- `lib/history/point-readings-provider.ts` — **the** serving provider for agg_5m/agg_1d (PR-12;
  ms↔timestamp + started↔createdAt translation).
- `app/api/data/route.ts` — primary data/serving endpoint (PR-12).
- `app/api/system/[systemId]/generator-events/route.ts` — readings-derived (PR-12).
- `app/api/admin/systems/[systemId]/point-readings/route.ts`,
  `app/api/admin/point/[systemIdDotPointId]/readings/route.ts` — raw readings (PR-12).
- `lib/db/turso/aggregate-daily-points.ts` — 1d aggregation compute (PR-11).
- `lib/point-aggregation-helper.ts` — 5m aggregation compute (PR-11). _(Reached via point-manager;
  confirm import path during PR-11.)_
- `app/labs/kinkora-hws/page.tsx` — lab readings view (PR-12; low priority).

### Mixed (config + readings + sessions) — touch in multiple PRs

- `lib/point/point-manager.ts` — point_info CRUD (config, PR-9) **and** raw insert + 5m
  aggregation + KV cache (readings, PR-11). Split the edits by concern.
- `lib/session-manager.ts` — session lifecycle (PR-7 session-id/UUIDv7 + co-enqueue).
- `app/api/system/[systemId]/point/[pointId]/route.ts` — point_info + readings.

### Vendor adapters (read config; write raw/5m + sessions)

- `lib/vendors/enphase/{adapter,enphase-history,enphase-today-energy}.ts` — 5m-native; their 5m
  stays queue-fed (PR-13 keeps these), read config from PG post-cutover.
- `lib/observations/publisher.ts` — uses point_info type only (no porting needed for reads).

### Ops / cron / sync

- `app/api/cron/daily/route.ts` — triggers 1d aggregation (PR-11).
- `app/api/cron/db-stats/route.ts`, `app/api/admin/storage/route.ts`, `app/api/health/route.ts` —
  stats/health (port opportunistically with their tables).
- `app/api/admin/sync-database/{route,stages}.ts` — dev-seed from **prod Turso**; becomes wrong
  once prod authority is PG (re-point to seed dev from PG, or retire — see plan).
- `app/api/enphase-proxy/route.ts` — enphase proxy.

### Scripts (offline; already dual-aware or Turso-only by design)

- `scripts/backfill-turso-to-postgres.ts`, `scripts/seed-planetscale-refs.ts`,
  `scripts/reconcile-agg-values.ts` — read Turso, write/compare PG (intended).
- `scripts/utils/fix-session-ids.ts`, `scripts/utils/fetch-enphase-raw.ts` — utilities.

### Tests

- `app/api/system/__tests__/point.integration.test.ts` — integration test against the dev
  server/SQLite; needs a PG-backed harness once reads move (test workstream, PR-12).

### Note

`db:sync-prod` (`package.json`) points at `scripts/sync-prod-to-dev.js`, which **does not exist**
— the documented dev-refresh path is already broken. Decide the post-cutover dev-seed source
(seed dev from PG) when porting `sync-database`.
