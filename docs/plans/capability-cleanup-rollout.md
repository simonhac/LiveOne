# Capability-cleanup — PROD rollout runbook

> Branch: `simonhac/areas-dashboards-cleanup`. Status: code (P3/P4/P5 + P6 SP-0/SP-1) committed +
> dev-verified; **nothing applied to prod yet.** This is the ordered, prod-touching runbook.
>
> **Golden rules** (from `CLAUDE.md`): PG migrations are manual and must be applied to prod **before**
> the dependent code deploys. `pscale backup create` before any data op / drop. For a column DROP,
> remove the field from `schema.ts` + stop reading it in the **deployed** code FIRST, then apply the
> drop. Prod = the standalone `sydney` branch; mint a short-TTL `pscale role` (no stored connection
> string). Never `drizzle-kit push`.

## Prod connection (each phase, short-TTL)

```bash
pscale role create liveone sydney rollout --inherited-roles postgres --ttl 1h --format json
# → use its database_url below as PROD_URL; for the data scripts:
#   PLANETSCALE_DATABASE_URL="$PROD_URL" ALLOW_PROD_DB_IN_DEV=true npx tsx --env-file=.env.local <script> --apply
#   (ALLOW_PROD_DB_IN_DEV bypasses the dev-guard deliberately; the scripts also refuse a mismatched host.)
# After a role that CREATED tables (migrations), reassign+delete it (table-ownership trap, see CLAUDE.md).
```

Every script here is **dry-run by default** (no `--apply`) and **snapshots affected rows first**. Run
the dry-run on prod and eyeball the plan before `--apply`.

---

## Phase 1 — Ship the capability cutover (migration `0021` + deploy the branch)

The capability code is **data-independent** — it renders prod's current dashboards (5/6/7/8/9 are v3;
1/3 are v2 but not rendered — `/device` builds fresh from capabilities). It only needs `systems.config`.

1. `pscale backup create liveone sydney` (base backup).
2. Apply **migration `0021`** (`ALTER TABLE systems ADD COLUMN config jsonb`) to sydney:
   `PLANETSCALE_DATABASE_URL_MIGRATIONS="$PROD_URL" npm run db:pg:migrate` (confirm host is sydney first).
3. Merge the branch → Vercel deploys `syd1`.
4. **Verify:** all three dashboards render (capability-driven, byte-identical to before); `/device/{1,13,14}`
   render; adding a card / seeding a dashboard works; no 500s in logs. Overrides: set a `systems.config`
   capability toggle on a test device and confirm it takes effect.

- **Rollback:** revert the deploy (the `config` column is additive/harmless to leave).

---

## Phase 2 — Prod data hygiene + membership + eager areas-of-one

These make prod match what was validated on dev. **Re-inspect prod first** — prod row ids/shapes differ
from dev; the scripts' pre-flight guards will refuse if reality doesn't match, so adjust the targets
(dashboard ids, area handles, test-system ids) in the scripts to prod before `--apply`.

1. `pscale backup create liveone sydney`.
2. **`scripts/cleanup/p1-data-hygiene.ts`** — un-break the multi-device site area (members + location),
   dedup duplicate dashboards, migrate any v2 descriptors → v3, drop test systems. (Adjust the `AREA_UUID`
   / dashboard-id / test-system constants to prod's values; keep the guards.)
3. **`scripts/cleanup/p2-backfill-membership.ts`** — area_devices = source ∪ bindings for 0-member areas.
4. **`scripts/cleanup/p6-eager-area-of-one-backfill.ts`** — an area-of-one for every system lacking one.
5. **Verify:** the once-broken site area renders whole-area tiles/chart/sankey; no duplicate dashboards;
   every system has an area-of-one + `area_devices` member; share tokens/grants intact.

- **Rollback:** each script wrote a snapshot to `scripts/cleanup/backups/` — restore from it, or PITR.
- After this, `liveone-dev` mirrors the cleaned prod on the next 2h sync (dev edits were ephemeral — see
  `docs`/memory `dev-sync-reverts-data-changes`).

---

## Phase 3 — P6 demolition (retire the legacy per-system dashboard path)

Shipped as **one code PR** (all sub-phases together — verified byte-safe on dev before merge) followed by
**one prod rollout** (a Phase-2-style session: data migration → the single drop migration). Consolidating
to one deploy means the deploy-before-drop gate is satisfied for all three columns at once.

**PR-A (code, merged + deployed first)** — no code reads the dropped columns after this:

| Sub-phase  | What                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SP-2**   | `/device/[...slug]/page.tsx` server-builds the real area-of-one via `buildAreaStrategyForHandle`; `DeviceViewer` takes `descriptor`+`area` props (shim gone).  |
| **SP-3**   | `allowedSystemIds` is purely descriptor-derived; `api-auth.ts`/`grants.ts` use `getDashboard` (descriptor-only), not `store.getDashboardById`.                 |
| **SP-4**   | `lib/dashboard/store.ts` **deleted**; `user-preferences.ts` rewritten to `default_dashboard_id`-only (Path B / per-system default / `default_system_id` gone). |
| **SP-8**   | `SystemsMenu` star removed; `SystemSettingsDialog` "default system" checkbox removed; `defaultSystemId` prop pipeline + `/api/user/preferences` branch gone.   |
| **schema** | Removed `dashboards.system_id`/`area_id`, `users.default_system_id`, `areas.source_system_id` (+ indexes/FKs) from `schema.ts` + every reader (admin/areas).   |

**Prod rollout (after PR-A is LIVE on prod):**

1. `pscale backup create liveone sydney`.
2. **`scripts/cleanup/p6-legacy-dashboards.ts`** (dry-run → `--apply`, backup-first): DELETE the vestigial
   legacy rows (`system_id NOT NULL` + `display_name IS NULL` + 0 tokens/grants — prod #1, #3), CONVERT
   any others in place, then null every `users.default_system_id`. Addresses the columns via **raw SQL**
   (they're already gone from `schema.ts`). Must leave every `dashboards.system_id` NULL.
3. **Apply migration `0022`** (`pscale backup` first; persistent `postgres` role). It drops all four
   columns; its head `DO` block `RAISE EXCEPTION`s if any `dashboards.system_id` survived step 2. Also
   apply `0022` to `liveone-dev` (schema drops aren't carried by the 2h data sync).

**Correctness hinges** (all satisfied by Phase 2 + verified pre-merge): every descriptor section `areaId`
is a real area uuid (else share scope → `∅`); legacy rows deleted/converted IN PLACE (0022 guard);
100% area-of-one coverage; owner default lands on `/dashboard/id/{id}`.

---

## What is NOT in this rollout (separate initiatives)

- **UUID re-key** of the KV/serving path off `legacy_system_id` — the committed follow-on; its own plan.
- **P7** — the configurator + per-device override toggle UI.
- Deferred minor tail: `staleThreshold(enphase)` → `config.updateCadenceSeconds`; residual dead
  `vendorType==='composite'` branches (composites are extinct); deprecated `doPoll`; duplicated KV key builders.
