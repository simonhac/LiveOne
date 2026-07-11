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

Full sub-phase design (SP-2…SP-8) lives in the P6 design (workflow output). Each ships independently,
low-risk-first; the three drop migrations are gated on the code that stops touching the column being
LIVE first. Order:

| Step     | What                                                                                                                                                                                              | Migration                                                 | Gate (must be live first)                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **SP-2** | Delete the `DeviceViewer` synthesis shim → server-render the real area-of-one (`buildAreaStrategyForHandle` in `app/device/[...slug]/page.tsx`)                                                   | —                                                         | Phase 2 (every device has an area-of-one)                                                    |
| **SP-3** | Repoint share/grant scope off `store.getDashboardById` → `getDashboard` (descriptor-only `allowedSystemIds`)                                                                                      | —                                                         | Phase 2 (all descriptors v3 with **real area uuids** — the correctness hinge)                |
| **SP-4** | Retire `lib/dashboard/store.ts`; unify default landing on `users.default_dashboard_id`; migrate legacy dashboard rows → composition **IN PLACE** (never delete+reinsert — token/grant FK cascade) | —                                                         | SP-3                                                                                         |
| **SP-5** | Drop `dashboards.system_id` + `dashboards.area_id` (+ index/FK/unique)                                                                                                                            | **0022** (guard: `RAISE EXCEPTION IF system_id NOT NULL`) | SP-4 live + fields removed from `schema.ts`/`get-dashboards-data.ts`/`AdminDashboardsClient` |
| **SP-6** | Drop `users.default_system_id` (+ index)                                                                                                                                                          | **0023**                                                  | SP-4 stops writing it + UI star repointed to `default_dashboard_id`                          |
| **SP-7** | Drop `areas.source_system_id` (+ index/FK)                                                                                                                                                        | **0024**                                                  | code stops reading/writing it (`sync.ts`/`create.ts`/`/api/areas`)                           |
| **SP-8** | Consolidate the two switcher menus (`SystemsMenu`/`DashboardsMenu`); star on `default_dashboard_id`                                                                                               | —                                                         | SP-6                                                                                         |

**Hardest to verify** (the design's top 5): (1) every dashboard descriptor section `areaId` is a real area
uuid (not `system-N`) before SP-3 — else share scope silently collapses to `∅`; (2) legacy→composition is
**in-place** (guard 0022 fires if any `system_id` survives); (3) 100% area-of-one coverage post-Phase-2;
(4) owner default lands on `/dashboard/id/{id}`; (5) `schema.ts` field-removal is deployed before each drop
(two `.select()`-all readers: `get-dashboards-data.ts`, `getOrCreateUserPreferences`).

**Take `pscale backup create` before each of 0022/0023/0024. Apply as the persistent `postgres` role.**

---

## What is NOT in this rollout (separate initiatives)

- **UUID re-key** of the KV/serving path off `legacy_system_id` — the committed follow-on; its own plan.
- **P7** — the configurator + per-device override toggle UI.
- Deferred minor tail: `staleThreshold(enphase)` → `config.updateCadenceSeconds`; residual dead
  `vendorType==='composite'` branches (composites are extinct); deprecated `doPoll`; duplicated KV key builders.
