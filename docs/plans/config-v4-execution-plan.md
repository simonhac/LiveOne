# Config v4 — execution plan

> **Status: ACTIVE (started 2026-07-22; Phases 0–13 shipped, Phase 14 is the last).** The _rationale_ is
> [config-v4-clean-sheet.md](config-v4-clean-sheet.md) — the canonical design doc and the source of the
> finish-line checklist (§4.8 "What dies"). This file is the _execution_ plan: what has landed, what is
> still legacy, and the phases that finish the job.
>
> **Handoff / continuing in a new workspace:** read (1) this file, (2) the clean-sheet for the why, then
> start at ▶ NEXT ACTION. Each stage is one branch/PR off `main`; branches are archived but this doc
> lives on `main`, so the next workspace always has the current plan.
>
> **Compressed 2026-07-29** from ~1,590 lines. The shipped phases are one line each and the per-slice
> narratives are gone — git has them. What survived: every binding decision, the full spec for work not
> yet done, and every trap that would otherwise be re-learned (**Traps and rules** — read it before
> touching a migration).

## ▶ NEXT ACTION — Phase 14, the last phase

**Phase 13 is COMPLETE (2026-07-31).** `areas.legacy_system_id` and `areas_legacy_system_unique` are
**dropped** from prod `sydney` and `liveone-dev`; prod is at **53 migrations, `inSync`**. The wire is
TypeID-native, the synthesis is gone, the KV keyspace is TypeID-keyed, and config-sense `system` is
spelled `device` in code. No outstanding migration debt.

Start at [Phase 14](#phase-14--v4-native-presentation-and-the-last-of-the-two-shapes). It is the largest
phase by volume and the only one left: one dashboard shape, the v3 descriptor and adapter deleted, the
unbuilt v4 mutation routes (**12** legacy handlers with no twin → **10** v4 handlers, since §9.2
collapses two POST/DELETE pairs into a `PUT`).

🛑 **The per-PR detail lives in [config-v4-phase14-prs.md](config-v4-phase14-prs.md)** — 22 PRs in seven
waves, each with a measured inventory, its own proof and a DO-NOT list. **Migrations 0053/0054/0055 are
RESERVED and assigned by the orchestrator only**; no agent may run `db:pg:generate` and claim a number
(parallel worktrees collide).

**Phase 14 has started.** Shipped so far:

- **PR 1 — strict area-ref decode ([#305](https://github.com/simonhac/LiveOne/pull/305), OPEN).**
  `areaRefToUuid` strict, `rowToDashboard`'s read-normalize gone, and `PATCH /api/dashboards/{id}`
  now 400s a non-`ar_` section ref — it previously stored `body.descriptor` **verbatim** (POST
  encoded, PATCH did not), which combined with strict decode would have let a write skip the
  no-escalation check. Precondition re-asserted on prod **and** dev: 16/16 `ar_` in both
  `descriptor` and `doc`, zero raw uuids, newest dashboard 2026-07-26. `areaRefToArId` stays
  dual-accept (three live raw-uuid producers).

**▶ NEXT: exercise the `/api/v4` surface — it has never run.** See the 🛑 STEP 0 note under Phase 14.
Not the plan's original "start with `default-section`", which is neither cheap nor a duplicate.

**Still open in Phase 14, untouched:** the `/api/data` `vendorSiteId` raw-uuid leak (real, confirmed —
fixed by a `devices.vendor_site_id` data migration, **0054**, decided 2026-07-31 over a new wire field);
the `descriptor` drop migration (**not written**); every renderer port; every v4 mutation endpoint.

🛑 **And a SECOND LIVE v3 RENDER PATH the plan did not know about — `/device/{id}`.** See Phase 14.

**What Phase 13 leaves on the floor for 14**, deliberately:

- **Plugin props still carry `handle`** — absorb it at the `v4-adapt.ts` boundary rather than touching 19
  plugins twice.
- ~~**The `/api/system*` → `/api/device*` back-compat rewrites**~~ ✅ **DELETED (Phase 14 stage 18,
  2026-07-31)** — both halves (`next.config.js` + the legacy `"/api/system/(.*)"` entry in
  `lib/route-matchers.ts`). They existed only for the stale-browser-bundle window.
- ~~**`scripts/utils/kv-drop-legacy-integer-keys.ts`**~~ ✅ **DELETED (Phase 14 stage 18)** — both
  environments swept; a final dry run found 0 legacy keys and 0 integer summary fields in `dev:` and
  `prod:` alike.

---

## Where we are

### Shipped

Phase 8 cut over the _hot path_ and the _presentation and sharing layer_ — **not** the config registry,
the integer handle, or the dashboard write model. Those are still v3, with v4 alongside as a dark mirror.

| Phase                       | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–1 Governance + `lib/ids/` | Prefixes locked; client-safe TypeID codec, six branded codecs (cross-entity misuse is a compile error).                                                                                                                                                                                                                                                                                                                                                       |
| 2 Point identity            | **0030**: `point_uid` NOT NULL, global `point_rid_seq` + `point_info.rid` backfilled deterministically.                                                                                                                                                                                                                                                                                                                                                       |
| 3 Readings DAO seam         | The highest-leverage strangler, no migration. 31 modules behind `ReadingsDao` over PRs A–L.                                                                                                                                                                                                                                                                                                                                                                   |
| 4–6 Additive v4 + `/api/v4` | **0032/0033/0034**: dark columns, `derivations`, `derived_intervals`, `dashboard_revisions`, `legacy_handles`; v4 doc model + rewriter + adapter; dashboards CRUD.                                                                                                                                                                                                                                                                                            |
| 7–8 **THE CUTOVER**         | **0035**, 2026-07-26. Planning ran as a 14-agent workflow that found 7 defects in a "23/23 green" transform. Dev cut over first as a dress rehearsal, prod the same day; **pollers never stopped** — only materialization paused.                                                                                                                                                                                                                             |
| 9 Post-cutover fixes        | prod→dev sync FK break (post-cutover `dashboards.id` is minted per-environment; only `legacy_id` is stable cross-env) + full `ar_` uniformity across `/api/areas/*`.                                                                                                                                                                                                                                                                                          |
| 10 Scaffolding demolition   | **0036–0039**: `_old` hot tables + `backfill_progress` dropped (~4.2 GB/env), hot index names canonical, cutover pause disarmed, `db:pg:generate` trustworthy again.                                                                                                                                                                                                                                                                                          |
| 11 Derivations              | **0040–0041**: run-tracking + HWS collapsed onto `derivations`; `device_trackers`/`device_run_periods` dropped.                                                                                                                                                                                                                                                                                                                                               |
| 12 **Registry cutover**     | **0043–0051**, finished 2026-07-30. `devices`/`points` are the only registry; `SystemsManager`, the dark mirror and `scripts/config-v4/` deleted; **`systems`, `point_info`, `polling_status` dropped**; `sessions`/`observations_outbox` on `device_rid`. Terminal window: ~11 min pause→drained, **no gap, no DLQ, no rollback**.                                                                                                                           |
| 13 **Kill the handle**      | **0052**, finished 2026-07-31 over seven PRs (#297–#303). Area-native serving + `ar_`/`dv_` on the wire; synthesis deleted and the `?areaId=` leg now authorizes the **area**; KV keyspace TypeID-keyed (four duplicate key-builders collapsed to one owner); `systems`→`devices` across 315 files behind back-compat URL rewrites; ~48 readers onto `legacy_handles` + a cross-table sync drift key; **`areas.legacy_system_id` dropped**. No window needed. |

Historical detail: [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md),
[config-v4-phase8-cutover.md](config-v4-phase8-cutover.md). Do not re-litigate them here.

### Still v3 — the actual remaining work

| Legacy thing still live                                                                                                                                                      | Retired in |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| ~~**The integer handle**~~ ✅ **DONE (Phase 13)** — column dropped; the handle lives only in `legacy_handles`, which is a permanent shim                                     | ~~13~~     |
| ~~**Virtual-system synthesis**~~ ✅ **DONE (Phase 13)** — `synthesizeAreaView`/`viewableByHandle`/`isAreaHandle` deleted                                                     | ~~13~~     |
| ~~**KV is integer-keyed**~~ ✅ **DONE (Phase 13)** — `latest:device:{dv_…}` / `latest:area:{ar_…}`, one key owner (`lib/kv-keys.ts`)                                         | ~~13~~     |
| ~~**`/api/data` is handle-addressed**~~ ✅ **DONE (Phase 13)** — accepts `areaId=ar_…`/`deviceId=dv_…`; payload `{device\|area, latest}`; `?systemId=N` is a permanent alias | ~~13~~     |
| **Dashboards dual-shape, v3-write** — `descriptor` and `doc` both NOT NULL and both written                                                                                  | Phase 14   |
| **Two live v3 render paths** — `/device/{id}` server-builds a `DashboardV3`; `components/Dashboard.tsx` is still mounted                                                     | Phase 14   |
| **Card plugins not v4-native** — 9 card plugins on `CardRenderProps`, two split registries, reached through `v4-adapt.ts` (the **9 tile** plugins already are v4-native)     | Phase 14   |
| **All v4 mutation routes missing** — 12 legacy mutation handlers with no twin → **10** v4 handlers to build; 28 legacy handlers across 15 routes still serve                 | Phase 14   |

## The finish line

**Done — all three, or the migration is not finished:**

1. **No legacy config code.** ✅ **DONE for everything except the descriptor items (Phase 14).** Gone:
   the tables, **the handle**, `point_info.index` + its allocator, tz/location on devices,
   `area_bindings.ordinal` + the int point pair, **the synthesis**, **the KV integer keyspaces**, the
   `"systemId.pointIndex"` ref grammar. Still live: `deviceSystemId` in descriptors, and the
   ≥1,000,000 area-handle allocator — which is **retained on purpose**, since `legacy_handles` is a
   permanent shim and new areas still need a handle minted.
2. ~~**No migration scaffolding.**~~ ✅ **DONE (Phase 12)** — `scripts/config-v4/` deleted, its
   `prebuild` wiring removed, the dark mirror gone, one-shot backfills deleted.
3. **One shape, not two.** No `isDashboardV3`/`isDashboardV4` branch, no adapter, no rewriter, one card
   registry, one write surface.

**Keep permanently — sanctioned shims, not debt:** `legacy_handles` (resolves `?systemId=N` forever),
`dashboards.legacy_id`, the `?systemId=N` compat alias, slug URLs, share-token strings, `lib/ids/`,
`lib/registry/{registry-cache,device-registry}.ts`, `scripts/check-readings-boundary.mjs` (the permanent
seam wall), and `scripts/utils/verify-areas-drift-key.ts` (the only remaining drift-key alarm).

**Shims WITH an expiry — delete deliberately, not permanently kept:** ✅ **all expired and deleted**
(Phase 14 stage 18, 2026-07-31) — the `/api/system*` → `/api/device*` rewrites in `next.config.js` plus
the paired legacy `"/api/system/(.*)"` entry in `lib/route-matchers.ts`, and the one-shot
`scripts/utils/kv-drop-legacy-integer-keys.ts`. Nothing on this list remains; do not confuse it with the
permanent list above, which is deliberately kept forever.

**Sequencing.** Phases 12 and 13 (done) unblocked the rest: the handle could not die while
`SystemsManager` was the config API, and the v4 mutation routes need `devices`/`points` as primary.
**Phase 14 is all that remains**, and it is the largest by volume.

---

## Phase 12 — Registry cutover ✅ SHIPPED 2026-07-30

**`devices`/`points` are the only registry.** `SystemsManager`, `v4-mirror.ts` and `scripts/config-v4/`
are deleted; `systems`, `point_info` and `polling_status` are dropped from both environments.
Migrations **0043–0051**. Per-slice narratives are in git; what survives here is the terminal-window
record and the findings that still bind.

| Slice            | What                                                                                                | Migration |
| ---------------- | --------------------------------------------------------------------------------------------------- | --------- |
| A · A2           | v4 registries into the sync manifest; mint-only mirror leaks closed                                 | [C]       |
| B · G · F · H    | `rid` DEFAULTs; `roles` dies; `user_systems` dies; `area_devices`→`area_members`                    | 0043–0046 |
| C                | `device_state` becomes the polling writer/reader; `polling_status` frozen                           | [C]       |
| D                | `pointForAddr` 17 → 2; `pointUid` a field on `PointInfo`                                            | [C] ×2    |
| E1 · E2a · E2b   | `area_bindings` off the int pair onto `point_uid`; area-builder wire → `pt_`                        | 0047–0048 |
| M                | `points` primary; **five** `max(index)+1` allocators die; one `mintPoint()`                         | [C]       |
| K1 · K2 · K3     | `DeviceConfigRegistry`; 79 reads moved; **`lib/systems-manager.ts` DELETED**                        | [C] ×3    |
| prep             | 0049 floors `device_rid_seq`; legacy `N.M` address retired; tz leak closed                          | 0049      |
| 1a · 1b          | `DeviceWriter` → `devices`/`areas`, dark mirror dies; ~20 `point_info` readers → `points ⋈ devices` | 0050      |
| **L + terminal** | two renames onto `device_rid`, **three DROPs**, scaffolding deleted (#296)                          | **0051**  |

### Findings that still bind

- **Slice D's headline correction.** `pointForAddr` was sized as the long pole and went 17 → 2 in two
  PRs, because nearly every caller already held the uuid. `points` has **no counterpart to
  `point_info.id`**, so it could never have been served from `points` at all. `SystemsManager` was the
  real long pole.
- **K was three PRs because `DeviceRegistry` had zero counterparts to any `SystemsManager` method** — it
  is an _addressing_ registry, so K was new code, never a rename. **Device-first precedence is LOCKED**
  (`resolveHandle`'s docstring claimed area-first and was simply wrong).
- **#291 — creating any device 500'd on prod** for three days since 0036, masked by an
  `ON CONFLICT … coalesce` path. Surfaced only because K3 drove a _create_ on dev.
- **Slice M found a live C7 hole armed but not fired** — three of five point allocators never mirrored.

### The terminal window, as executed (2026-07-30)

PR **#296** merged as `d16429fa`; **0051** applied to prod then dev. Pause → lag-0 in **~11 minutes**;
**no data lost, no gap, no DLQ, no rollback**. Both environments post-checked on the catalog: three
`to_regclass` NULL, `sessions.device_rid` present with `system_id` gone, the new FK **`convalidated`**,
`device_rid_seq` 10001 ≥ max rid 10001, `point_rid_seq` 166 ≥ 134, 1,076,342 session rows intact,
`db:pg:generate` → _No schema changes_.

Cheaper than planned in two ways worth reusing: **`parallelism` was already 1**, making the "set to 1
then restore" steps no-ops; and the **Development-scope `OBSERVATIONS_QSTASH_TOKEN` controls the prod
`observations` queue** (one Upstash account, queues namespaced by `NODE_ENV`), so pause/resume is a CLI
operation and the Clerk-gated admin route is not needed.

**The pre-drop oracle was banked BEFORE the merge** — `verify-slice-k1-parity.ts` on prod at
**16 handles / 288 checks / 0 divergences** — because the PR deletes it. Run a retiring oracle while it
still exists, or you are improvising from a detached checkout with the queue paused.

**Non-findings, recorded so they are not re-chased:** ~24-min gaps on points 76–83 are a pre-existing
vendor pattern recurring every 8–12 h; future-dated `point_readings_agg_5m` rows are **Amber forecasts**,
which Amber writes into the 5m agg table by design.

## Phase 13 — Kill the handle ✅ SHIPPED 2026-07-31

Seven PRs (#297–#303), migration **0052**, no maintenance window. The per-PR detail file is deleted —
git is the archive; the PR bodies carry the measurements. What survives here is what still binds.

### Findings that still bind

- 🛑 **`scripts/utils/verify-areas-drift-key.ts` is now the ONLY instrument** that can tell a working
  prod→dev drift key from a broken one. Dropping `areas_legacy_system_unique` removed a backstop: before
  0052, a missed `areas` drift key **aborted** the sync on that index. After 0052 the same miss exits 0
  and lands prod's row **alongside** the drifted dev row — the same logical area under two uuids. This is
  an accepted, permanent downgrade. **Run that script after any change to the `areas` `idDrift` leg.**
- 🛑 **Handle 13 is both a real Sigenergy device and a 3-member area** (trap D-l). `resolveHandle` returns
  both legs and states no precedence. `?systemId=N` resolves **device-first, forever** — that is the
  behaviour-preserving order and it is written down at the top of `lib/dashboard/subject.ts`. The
  area-native reading of a colliding handle is reachable only through an explicit `ar_…`.
- **The `?areaId=` leg authorizes the AREA**, not the handle. `prefer` is threaded _into_
  `requireDashboardAccess` so the grant names the entity being served. Do not reintroduce a post-hoc leg
  swap after the grant — the area is a **superset** of the device sharing its handle.
- **Areas still mint a handle** into `legacy_handles` at creation; `allocateAreaHandle` computes
  `max(legacy_handles.handle)`, a superset of the old read, so the floor only ratchets up.
- **`HandleAreaConflictError`** exists because `ensureAreaForHandle`'s `ON CONFLICT DO UPDATE … coalesce`
  silently swallowed a recycled-`rid` collision. The PK is not a substitute for it.

### Traps this phase added

- 🛑 **`liveone-dev` is SHARED infrastructure** — every agent worktree, Vercel previews, and local dev.
  "Apply on dev only" is not a sandbox instruction. **The drop-ordering rule applies to dev too:** the
  code that stops reading the column must be running there before the column goes, or every `main`-based
  build 500s. (Learned by breaking dev mid-phase.)
- 🛑 **A projection-less `.select()` is invisible to grep.** `lib/admin/get-areas-data.ts` read
  `area.legacySystemId` off a `select().from(areas)` that names no columns. It survived a ~48-site
  conversion sweep and every raw-string grep; **only deleting the field from `schema.ts` surfaced it.**
  Before any column drop, delete the field from `schema.ts` first and let `tsc` find the readers.
- 🛑 **`db:pg:migrate` reports success from a STALE WORKTREE.** Running it from a checkout that lacks the
  new migration file connects, finds nothing pending, and prints "migrations applied successfully".
  Post-check the **catalog**; never the migrate output. (Hit during the 0052 prod apply.)
- ⚠️ **`git stash` is repo-wide, not per-worktree** — parallel agents share one stack, and `lint-staged`
  shells out to it. Commit instead; use `--no-verify` and run prettier by hand.
- ⚠️ **A renamed API path breaks already-open browser tabs.** The same rolling-deploy argument that
  protects `QueueMessage`'s QStash keys applies to URLs: stale bundles keep calling the old path. Hence
  the `next.config.js` rewrites — and note **middleware runs BEFORE them**, so a legacy path also needs
  its `lib/route-matchers.ts` entry or an anonymous share-token viewer gets an edge 404.
- ⚠️ **A stale `.next-build/types/validator.ts`** referencing old route paths fails `type-check` with
  `TS2307` after a rebase across a route rename. `rm -rf .next-build`.

## Phase 14 — v4-native presentation, and the last of the two shapes

**Goal:** one dashboard shape. Delete the v3 descriptor, the rewriter, the adapter and the legacy route
handlers. Largest phase by volume; last because it depends on Phase 12's registries.

🛑 **Per-PR detail: [config-v4-phase14-prs.md](config-v4-phase14-prs.md)** — 22 PRs, seven waves, each
with a measured inventory, its own proof and a DO-NOT list. Migrations **0053** (drop `descriptor`),
**0054** (helper `vendor_site_id`) and **0055** (signal-neutral run stats) are **RESERVED**; the
orchestrator assigns numbers, because parallel worktrees collide on `db:pg:generate`.

- **Port the card plugins to v4-native** — one `CARD_RENDERERS` keyed on `card-types.ts`' 18 unified
  types, replacing the split card (10) + tile (9) registries; then delete `v4-adapt.ts`.
- **Build the v4 editor** so the write model is v4; move the page shell onto the doc, make
  `temporal-cards.ts` v4-aware.
  > ⚠️ **A2's fix regenerates `doc` UNCONDITIONALLY, which is only safe while `doc` has no independent
  > author.** The moment this phase ships an editor that writes `doc` directly, a descriptor PATCH will
  > **clobber v4-authored structure** — so the editor work must turn this into a reject-or-merge
  > decision, not an overwrite. Dropping `descriptor` is the real fix.
- **Build the missing `/api/v4` mutation endpoints**, then retire the 28 legacy handlers across 15
  routes.

  > **Counts re-measured 2026-07-31 against `fa64b2d2`.** "28 legacy handlers across 15 routes" is
  > **correct**, but the split is **15 mutations / 13 reads**, not 16/12. Of the 12 mutation handlers
  > with no v4 twin (7 area + 5 dashboard-sharing), §9.2 collapses `POST`+`DELETE …/devices` into one
  > `PUT …/members` and `POST`+`DELETE …/grants` into one `PUT …/grants` — so it is **10 v4 handlers to
  > build**, not 12. Of the 7 legacy READs with no twin, **3 are already dead**
  > (`GET /api/areas?systemId=`, `GET …/bindings` — bindings ride inside the `[areaId]` GET payload —
  > and `GET /api/dashboards/{id}`, integration-test-only) and 2 belong with the sharing port
  > (`grants`, `share`), leaving **4 orphan area reads** to port: `candidate-devices`, `by-handle`,
  > `provenance-daily`, `provenance-summary`.
  >
  > 🛑 **Each v4 twin needs its own `lib/route-matchers.ts` entry.** `by-handle`,
  > `provenance-summary` and `recompute-provenance` are in `publicRoutes` (they authenticate by
  > `CRON_SECRET` in-handler); **`provenance-daily` is in `shareableRoutes`** — an anonymous `?access=`
  > viewer fetches it for the battery-provenance panel. Middleware runs before the rewrites, so a
  > missing entry is a silent edge 404 for anonymous viewers and invisible to a logged-in tester.

  > 🛑 **STEP 0, and it is not optional: the entire `/api/v4` surface is DARK.** Measured 2026-07-31 —
  > **zero callers and zero tests**. No `fetch()` anywhere in `app/`, `components/`, `lib/`, `hooks/`
  > or `scripts/` hits any `/api/v4/*` route, and there are no tests under `app/api/v4/`. So no legacy
  > handler may be retired onto a v4 twin until that twin has been exercised at least once — expect
  > defects, since this code has never run. Driving it is cheap: a real Clerk session JWT from
  > `scripts/utils/get-test-token.ts` passes the middleware (verified 2026-07-31).

  > ⚠️ **`/api/areas/[areaId]/default-section` is NOT "already a straight duplicate of its v4 twin"**
  > and is a poor first move. The legacy route returns a v3 **section**; the v4 twin returns a v4
  > **group node**. Its sole caller (`components/AddAreaDialog.tsx`) immediately PATCHes the section
  > into a v3 descriptor, so retiring it means replacing **two** calls (default-group + a doc `PUT`) —
  > it is coupled to the editor port, not independent of it.

- **Drop `dashboards.descriptor`**; delete `lib/dashboard/{v3,cards,v3-to-v4}.ts`, `v4-seed.ts`'s v3
  detour, and every `isDashboardV3`/`isDashboardV4` branch. Retire the bridge tests — **285 LOC**, not
  ~362 (`v3-to-v4.test.ts` 180 + `v4-adapt.test.ts` 105).

  > 🛑 **Delete the field from `schema.ts` FIRST and let `tsc` enumerate the readers** (the trap below).
  > And note **a v4 route already writes `descriptor`** — `app/api/v4/dashboards/route.ts:123` inserts
  > `emptyDashboardV3()`, because the column is NOT NULL. "v4 doesn't touch descriptor" is false.

- ~~**Tighten to strict decode**~~ ✅ **DONE (PR [#305](https://github.com/simonhac/LiveOne/pull/305)).**
  Still open from that bullet: the `/api/data` `vendorSiteId` raw-uuid leak — helper devices carry
  `helper:area:<raw uuid>` (`lib/areas/helper-site-id.ts:12`), emitted verbatim at
  `lib/dashboard/serve-data.ts:169` and parsed back out client-side at
  `components/dashboard/cards/battery-provenance-history.tsx:24-25`. **Fixed by migration 0054**
  rewriting the column to `helper:area:ar_…`, dual-accept decoder deployed first.
- **Queued card work, unblocked here:** HWS 7-day stripe → a generic `daily-stripe` card, and the heatmap
  → a `heatmap` card. See [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md).
- **Close out** — delete the phase-7/8 docs; fold anything still true into
  `docs/architecture/data-model.md`. Git is the archive. 🛑 **This file is KEPT** (Simon, 2026-07-31),
  rewritten as the epic's completed record — that overrides the original "delete this file".

### 🛑 There are TWO live v3 render paths, not one

The rest of this plan assumes one. Measured at `fa64b2d2`:

- **`/dashboard/{…}`** — `components/DashboardClient.tsx:231` branches
  `dashboard.doc ? <DashboardV4View> : <Dashboard>`. Since the Phase 8/10 cutover `doc` is NOT NULL,
  **the v3 branch is never taken.**
- **`/device/{id}`** — `app/device/[...slug]/page.tsx:262` server-builds a transient `DashboardV3` from
  `buildAreaStrategyForHandle` and renders it through `components/DeviceViewer.tsx:169` →
  `components/Dashboard.tsx`. **Live on every page view.**

`components/Dashboard.tsx` has exactly two importers — `DeviceViewer.tsx:9` (live) and
`DashboardClient.tsx:8` (the never-taken fallback). **`lib/dashboard/v3.ts` and the v3 renderer cannot
die until `/device/{id}` is ported**, and `lib/dashboard/temporal-cards.ts` (both consumers) must walk
a `DashboardV4` at the same time.

**Risk:** the plugin port is where visual regressions hide and there is no snapshot coverage. Port
plugin-by-plugin behind the still-present adapter and remove the adapter last, so each is independently
revertible.

**Port surface, measured 2026-07-31 — much smaller than "19 plugins" suggests:**

- **9 of 19 (every tile) is ALREADY v4-native.** `TileRenderProps`
  (`components/dashboard/tiles/types.ts:13-24`) has no `card` and no `section`; `V4TileCell`
  (`components/dashboard/v4/node-view.tsx:107-134`) already calls them with identical props, bypassing
  the adapter. Their only v3 tie is the `TileView` type import.
- The port is the **card plugins**, and **5 of 10 read only `handle`** (`amber-now`, `amber-timeline`,
  `battery-contents`, `chart`, `ev-provenance`); `sankey` reads no props at all (`Render: () => null`).
- The whole risk is **5 prop reads in 4 files**: `card.deviceSystemId` (`device-metrics:14`,
  `generator-runs:14`), `card.variant` (`device-metrics:24`), `card.chart` (`chart:42-46`, in
  `collapseKey`), `section.areaId` (`battery-provenance-history:26-27`).
- 🛑 **`tiles-card.tsx` is NOT ported — it is already unreachable from the v4 renderer.** `"tiles"` is
  deliberately absent from `V4_CARD_TYPES` (`lib/dashboard/card-types.ts:18-39`; the rewriter turns a
  v3 `tiles` card into a `row` group), so `v4CardRenderKind("tiles")` returns `"unknown"` and
  `node-view.tsx:185-189` renders the placeholder, never `tilesPlugin`. Its only live mount is
  `components/Dashboard.tsx`; it dies with that file.
- 🛑 **Pixel equivalence is not provable at reasonable cost, and does not need to be.** Four card
  plugins bottom out in chart.js on a `<canvas>` (zero DOM) and `useTemporalRange` calls
  `useSearchParams()` during render; there is no React-rendering test in the repo and no
  jsdom/testing-library installed. **Prop-level equivalence is a sound substitute here**: the leaf
  components are unchanged, so identical props ⇒ identical pixels. Mock the leaves to capture props
  and all 19 become provable with **zero new dependencies** (`react-dom/server` is already present).
- 🛑 **Two ways to write a React test that is silently never run.** All three jest configs are
  `testEnvironment: "node"` with `testMatch: **/__tests__/**/*.test.ts` — **a `.tsx` test is not
  collected** — and `roots` are `lib`/`app`/`scripts`/`packages`, so **anything under `components/` is
  not collected either.** There is no `components/__tests__` today, so nothing has ever caught it. Put
  the harness under `lib/**/__tests__/*.test.ts`.
- ⚠️ **`battery-provenance-history.tsx:26`'s `section.areaId.startsWith("device-")` sentinel is dead on
  the v4 path but NOT dead in the tree.** `synthSectionV3` can only supply the area uuid or `""` — but
  the sentinel has a live producer at `app/device/[...slug]/page.tsx:261`
  (`getAreaForDevice(...)?.id ?? \`device-${device.id}\``) feeding the v3 renderer. It dies with the
`/device` port, not before.

---

## Locked decisions

- **ID scheme.** TypeIDs: `prefix_` + Crockford-base32(UUIDv7). The DB stores the raw `uuid`; the prefix
  is wire/URL only; `lib/ids/` is the single source of truth. `dv` device, `pt` point, `ar` area, `db`
  dashboard, `dx` derivation, `bn` binding. Slugs stay for pretty URLs, share tokens stay 3-word
  phrases, doc nodes keep local `n_…` ids.
- **The seam rule.** Uuids above, rids below. `registry-cache.ts` is the only owner of
  uuid↔rid↔address; `readings/schema-internal.ts` the only importer of the hot tables; `readings/dao.ts`
  the only SQL. Enforced by `no-restricted-imports` + `scripts/check-readings-boundary.mjs`. Permanent.
- **Eager areas — Option A.** Areas-of-one are kept (deleting them would destroy uuid-keyed
  `flow_attr_1d` / `battery_provenance_daily` history). Every device has exactly one `primary_area_id`
  (NOT NULL); the area-of-one is the sole home for tz/location. Filtered from the picker at render time.
- **Simon is the sole user.** Prefer a simple change with a short outage over machinery that minimises
  downtime. Share tokens are the one genuine multi-party surface.
- **KV is a disposable cache** — rebuild from PG rather than migrating it.
- **Adapter over rewrite** for the v4 render window. `oe-grid` → area-level; `/api/v4` replaces rather
  than coexists; doc depth cap 4; group `direction` defaults to `column`.

## Traps and rules

Each was learned by breaking something; they are why the shipped narratives could be deleted.

- 🛑 **Drops invert the ordering rule.** "Migrations lead code to prod" is the **additive** rule. For a
  DROP, **deploy the code that stops referencing the column first**. A projection-less `.select()`
  expands to the columns declared in the _running_ build, so any column drop breaks prod until the new
  build is live. (Learned by breaking prod during 0037.)
- 🛑 **Every v4 column was wired at MINT and not at EDIT.** Before converting a read path to a v4 column,
  **enumerate its writers, not its mint site.** Five instances: A2 found three (`updatePoint`,
  `updateDashboard`, `updateSystem`), H a fourth (the whole `area_members` table), E a fifth
  (`area_bindings.point_uid`). Slice M's survey found a sixth shape — three of four point allocators
  never mirror at all. Assume the next exists until you have listed the writers.
- ⚠️ **Nullability that preserves behaviour also hides a missing writer.** "Null inherits the old MISS
  semantics exactly" is a real safety property _and_ the reason a writer gap is invisible. That is what
  made slice E PR 1 a live defect rather than a tidy-up.
- 🛑 **Post-check the DATABASE, not the migrate output.** On `liveone-dev` the migrator reports success
  while doing nothing if the journal already carries the entry. Check the last-applied **hash**, not the
  row count — a count cannot tell you whether the pending file is the one you think it is.
- 🛑 **Validation belongs INSIDE the migration**, as a `DO` block with `RAISE EXCEPTION` — the only check
  that cannot be raced between probe and apply. Never `CASCADE` a drop: an unexpected dependent must
  abort, not vanish. And **`db:pg:migrate` swallows `RAISE NOTICE`**, so capture inventories by hand
  first or the record is lost.
- 🛑 **A ROW-COUNT inventory is not a backup.** The banked pre-0051 inventory held counts and a
  `systems` id list — not what the tables _contained_. Before an irreversible drop, take a real
  `pg_dump --data-only` of every doomed table (it took seconds; 134 + 16 + 11 rows, 66 KB). Write it
  under gitignored `.context/` — this dump carries serials and vendor ids and the repo is public.
- 🛑 **A QStash queue pause is EVENTUALLY CONSISTENT, in both directions — a DB watermark is the wrong
  instrument for detecting when it took hold.** Pausing, then immediately sampling
  `max(sessions.created_at)` over 62 s, showed both watermarks _advancing_ — which reads exactly like
  "the pause failed, there is a second write path," and nearly sent the window hunting a bypass that
  does not exist. Already-dispatched messages keep landing for **1–2 minutes** after the API returns
  200; the same lag applies on resume (45 s of apparent silence before deliveries flow). **Wait ~90 s
  after pause or resume, and confirm against the QStash event log (`GET /v2/logs` — last `DELIVERED`,
  then `CREATED`-only), not against the database.**
- 🛑 **Never `pscale role reset-default` on prod.** It rotates the `postgres` password prod's
  Production-scope vars carry, and Vercel captures env at deploy time — prod 500s until redeployed.
  Unnecessary for a `[D]` slice: a drop migration creates no objects, so a temp role owns nothing.
- ⚠️ **Every migration goes to prod FIRST, then dev** — `prod-dev-sync.ts` reads columns at runtime, so a
  _dev_ column prod lacks trips the schema preflight. And **parallel workspaces collide on migration
  numbers**: `git fetch origin main` and check both the directory and the live journal before generating.
- ⚠️ **A dev-side check is only evidence about prod when the sync is demonstrably green.** Probe prod
  directly under a short-TTL read-only role, and confirm it really is prod two ways (the role username
  carries the prod branch token; `max(measurement_time)` is ~0 min behind, since dev's crons are off).
- 🛑 **A projection-less `.select()` is invisible to EVERY grep.** `select().from(areas)` names no
  columns, so a reader of a doomed column leaves no string to search for. Phase 13's sweep converted ~48
  sites, hand-grepped raw SQL, and still missed `lib/admin/get-areas-data.ts` — found only when the field
  was deleted from `schema.ts`. **Before a column drop, delete the field from `schema.ts` first and let
  `tsc` enumerate the readers.** That is the only complete inventory.
- 🛑 **`liveone-dev` is SHARED infrastructure** — every worktree, Vercel previews, and local dev servers.
  "Apply on dev only" is not a sandbox instruction. **The drop-ordering rule applies to dev as well as
  prod:** the code that stops reading the column must be running there before the column goes.
- 🛑 **`db:pg:migrate` prints "applied successfully" from a checkout that LACKS the migration file.** It
  connects, finds nothing pending, and exits 0. Combined with the older dev-journal variant, the rule is
  absolute: **post-check the CATALOG, never the migrate output** — and confirm the migrations directory
  actually contains the file you think you are applying.
- ⚠️ **`git stash` is repo-wide, not per-worktree.** Parallel agents/worktrees share one stack, and
  `lint-staged` shells out to it. Prefer committing; `--no-verify` + prettier by hand when a hook fights.
- ⚠️ **Renaming an API path breaks already-open browser tabs**, for the same reason renaming a QStash
  message key breaks in-flight messages: a deploy leaves stale bundles live. Ship `next.config.js`
  rewrites — and note **middleware runs BEFORE rewrites**, so a legacy path also needs its
  `lib/route-matchers.ts` entry, or anonymous share-token viewers get an edge 404.
- ⚠️ **Hand-written `sql` fragments are invisible to tsc** — a rename or drop breaks them silently, so
  they must be _driven_, not compiled. (Bit slice H.) **This is the single most reliable failure mode of
  the whole migration — it bit six times in Phase 12 alone**, most recently two raw-SQL strays that
  survived a green `tsc` and the full suite. Re-run the raw-SQL grep by hand before every drop.
- ⚠️ **Read the producer, not the consumer, before sizing a conversion.** Three of slice D PR 2's six
  sites already held the uuid and were never blocked at all.
- ⚠️ **A DELETE predicate must be driven POSITIVELY.** It fails silently in both directions —
  under-delete leaves a dangling row, over-delete removes a live one. `area-builder-smoke.ts` clears
  bindings _before_ removing a member, so its `removeMember` call only ever ran the statement against
  zero rows: it proved the SQL parses, not that it selects the right rows. A two-member area with a
  binding on each is what actually proves it.
- ⚠️ **When a v4 column goes NOT NULL, the constraint is its WIRE-facing readers, not its internal
  ones.** Internal readers convert freely; the wire cannot until its grammar changes. That asymmetry is
  why a contract migration **relaxes** the legacy column instead of dropping it — the intervening state
  has to be representable, or two PRs collapse into one un-splittable change.
- 🛑 **Migration preconditions read the CATALOG, never the drizzle journal.** The journal records
  intent; the catalog records what is true of _this_ branch. 0048 proves 0047 landed by checking that
  `area_bindings_unique` actually keys on `point_uid`.
- 🛑 **A parity gate over two homes for one value must be DIRECTIONAL.** The two directions mean opposite
  things — one is a serving loss, the other the designed end state — so a symmetric equality check either
  fails on correct data or gets widened into a tautology. State the authority; assert only the losing
  direction; make any repair one-directional and NULL-only. This bit three separate gates in Phase 12
  (`location`, G2, and k1-parity after slice K).
- 🛑 **A `max(x)+1` scan is a PATTERN, not an allocator — grep the TABLE, not the function.** Slice M's
  plan named one; there were five, and three also skipped the mirror the fourth called.
- ⚠️ **A doc comment describing dispatch order, or naming a future slice, is a CLAIM about code.**
  `resolveHandle`'s "area-first" prose was wrong and nearly re-pointed a shared dashboard; three separate
  "until slice M" comments were stale by the time M ran. Verify before following.
- ⚠️ **Adding an FK to a column a pre-mint writer fills breaks FIRST CREATION ONLY**, and an
  `ON CONFLICT … coalesce` masks it on every idempotent re-run. An FK addition needs a
  create-from-scratch test, not a re-run test. That is how #291 hid for three days.
- ⚠️ **A NOT NULL column cannot be healed by a fill-if-NULL reconcile — it never looks missing.** That is
  why the tz leak survived eight earlier passes of the same defect class.
- ⚠️ **Exercise WRITERS, not just readers, at the end of a slice.** The only reason the prod device-create
  break surfaced at all is that slice K3 drove a create on dev.
- 🛑 **Re-assert an equivalence inside the migration that destroys your ability to check it.** After a
  DROP there is no second address left to disagree with, so a divergence introduced since the last
  check becomes silent and permanent. A check that can only ever run once should run.
- 🛑 **A column drop is only half the change when a persisted derived store keys off it.** The KV
  subscription registry had to be rebuilt on both environments _between_ the deploy and the drop —
  that is a deploy step, and it belongs in the PR body and the migration header, not in the reviewer's
  memory.
- ⚠️ **Removing a FK turns any join onto the replacement key into a silent filter.** Prefer a
  replacement join that is itself FK-backed and NOT NULL; if none exists, add a reachability assertion.
- ⚠️ **When a check becomes DB-enforced, replace it with the next unenforced invariant, or delete it.**
  A passing tautology reads as coverage. The parity gate's block 0 went from "is `point_uid` non-null"
  (now enforced by 0047) to binding→`point_info` reachability.
- ⚠️ **A mocked query-builder chain encodes arity**, so re-shaping a query is a test change by
  construction — a stale chain returns `undefined` and yields zero rows _silently_. If re-shaping a
  query did not require touching its mock, the mock is not asserting anything.
- 🛑 **A pre-flip reconcile tool REVERSES direction the moment the flip lands, and its drift report
  inverts with it.** `reconcile-device-state.ts` would have rewound live counters post-flip, because
  `polling_status` was frozen while `device_state` advanced — and post-flip the two are _supposed_ to
  diverge, so its report read as alarming when it was correct. Delete such a tool at the flip; a spent
  one-shot that still runs is worse than no tool. (Both it and the completed one-off backfills went with
  `scripts/config-v4/` in the terminal window — they could not have been "left alone", since they stop
  compiling once their tables leave `schema.ts`.)

## Open follow-up — run-interval statistics assume the signal IS power

`derived-intervals-pg.ts` writes `max/min/avg_power_w` as statistics of the **signal series**, whatever
it is. Fixed 2026-07-28 without a schema change (the route resolves the signal point's name/unit and
returns a server-computed `columns` plan; `avgPowerW` now comes from energy ÷ duration). **Deferred to
Phase 14:** rename `*_power_w` to something signal-neutral carrying a unit, which is what would retire
the `detector_version` gate now suppressing `avgSignal` for rows whose units predate the DSE re-point.
Prod's history is **mixed-unit and permanently so** — a dynamic "rpm" header would print pre-11-Jul
Watts as rpm. Cost/emissions columns are a separate, larger piece:
[run-period-provenance.md](run-period-provenance.md).
