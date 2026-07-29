# Config v4 — execution plan

> **Status: ACTIVE (started 2026-07-22; Phases 0–11 shipped, Phase 12 in progress).** The _rationale_ is
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

## ▶ NEXT ACTION — Phase 12 slice **M**: `point-manager` mints `points` directly

Phases 10 + 11 COMPLETE. **✅ SLICE E IS COMPLETE** — all of A, A2, B, C, D, E, F, G, H shipped, and
**0047 + 0048 are applied to BOTH environments** (2026-07-29). `area_bindings` has exactly one
address, **FKs into `point_info` are 0, and slice N is unblocked.** No outstanding migration debt.
Remaining: **M → K → the terminal window**.

---

## Where we are

### Shipped

Phase 8 cut over the _hot path_ and the _presentation and sharing layer_ — **not** the config registry,
the integer handle, or the dashboard write model. Those are still v3, with v4 alongside as a dark mirror.

| Phase                       | What landed                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–1 Governance + `lib/ids/` | Prefixes locked; client-safe TypeID codec, six branded codecs (cross-entity misuse is a compile error).                                                          |
| 2 Point identity            | **0030**: `point_uid` NOT NULL, global `point_rid_seq` + `point_info.rid` backfilled deterministically.                                                          |
| 3 Readings DAO seam         | The highest-leverage strangler, no migration. 31 modules behind `ReadingsDao` over PRs A–L.                                                                      |
| 4–6 Additive v4 + `/api/v4` | **0032/0033/0034**: dark columns, `derivations`, `derived_intervals`, `dashboard_revisions`, `legacy_handles`; v4 doc model + rewriter + adapter; dashboards CRUD. |
| 7–8 **THE CUTOVER**         | **0035**, 2026-07-26. Planning ran as a 14-agent workflow that found 7 defects in a "23/23 green" transform. Dev cut over first as a dress rehearsal, prod the same day; **pollers never stopped** — only materialization paused. |
| 9 Post-cutover fixes        | prod→dev sync FK break (post-cutover `dashboards.id` is minted per-environment; only `legacy_id` is stable cross-env) + full `ar_` uniformity across `/api/areas/*`. |
| 10 Scaffolding demolition   | **0036–0039**: `_old` hot tables + `backfill_progress` dropped (~4.2 GB/env), hot index names canonical, cutover pause disarmed, `db:pg:generate` trustworthy again. |
| 11 Derivations              | **0040–0041**: run-tracking + HWS collapsed onto `derivations`; `device_trackers`/`device_run_periods` dropped.                                                  |

Historical detail: [config-v4-phase7-rehearsal-harness.md](config-v4-phase7-rehearsal-harness.md),
[config-v4-phase8-cutover.md](config-v4-phase8-cutover.md). Do not re-litigate them here.

### Still v3 — the actual remaining work

| Legacy thing still live                                                                                  | Retired in |
| ---------------------------------------------------------------------------------------------------------- | ---------- |
| **Config registry is v3-primary** — `systems` 28 query sites / 23 files, `point_info` 40/20              | Phase 12   |
| **The dark mirror is load-bearing** — `v4-mirror.ts` writes `points`/`devices` at every mint; deleting it re-opens defect **C7** (a new point gets no `points` row → the hot FK rejects its first reading → QStash poison pill) | Phase 12   |
| **`SystemsManager`** — 464 lines, 66 importers, 78 `getInstance()` sites, the largest blast radius        | Phase 12   |
| **The integer handle** — `areas.legacy_system_id`, 186 occurrences incl. inside `/api/v4/*`; `AREA_HANDLE_BASE` still allocates | Phase 13   |
| **Virtual-system synthesis** — `synthesizeAreaView`, `getViewableSystem` (6 callers), `isAreaHandle` (2) | Phase 13   |
| **KV is integer-keyed** — `latest:system:N` / `subscriptions:system:N` is the ONLY keyspace              | Phase 13   |
| **`/api/data` is handle-addressed** — `?systemId=<int>`, payload `{system, latest}`                      | Phase 13   |
| **Dashboards dual-shape, v3-write** — `descriptor` and `doc` both NOT NULL and both written              | Phase 14   |
| **Zero v4-native renderers** — 19 plugins, two split registries, reached through `v4-adapt.ts`           | Phase 14   |
| **All v4 mutation routes missing** — 10 unbuilt; 28 legacy handlers across 15 routes still serve         | Phase 14   |

## The finish line

**Done — all three, or the migration is not finished:**

1. **No legacy config code.** Every clean-sheet §4.8 item gone: the tables, the handle,
   `point_info.index` + its allocator, tz/location on devices, `area_bindings.ordinal` + the int point
   pair, the synthesis, the ≥1,000,000 allocator, the KV integer keyspaces, the `"systemId.pointIndex"`
   ref grammar, `deviceSystemId` in descriptors.
2. **No migration scaffolding.** `scripts/config-v4/` deleted, its `prebuild` wiring removed, the dark
   mirror gone, one-shot backfills deleted.
3. **One shape, not two.** No `isDashboardV3`/`isDashboardV4` branch, no adapter, no rewriter, one card
   registry, one write surface.

**Keep permanently — sanctioned shims, not debt:** `legacy_handles` (resolves `?systemId=N` forever),
`dashboards.legacy_id`, the `?systemId=N` compat alias, slug URLs, share-token strings, `lib/ids/`,
`lib/registry/{registry-cache,device-registry}.ts`, and `scripts/check-readings-boundary.mjs` (the
permanent seam wall).

**Sequencing.** Phase 12 precedes 13 (the handle can't die while `SystemsManager` is the config API) and
14 (the v4 mutation routes need `devices`/`points` as primary). Phase 14 is last and largest.

---

## Phase 12 — Registry cutover: `devices`/`points` become primary

**Goal:** make the v4 registries the only registry, retire `SystemsManager`, drop `systems`,
`point_info`, `polling_status`, and delete the dark mirror.

Ordered PRs off `main`, **not** one long branch — the code/DDL interleave has to land at merge points,
and a long branch has none (the 0037 lesson). **[A]** additive → prod before the code merges.
**[D]** drop → code merged and deployed first, then prod, then dev. **[C]** code-only.

### Slices shipped

| Slice  | What                                                                                    | Migration |
| ------ | ----------------------------------------------------------------------------------------- | --------- |
| **A**  | v4 registries into the prod→dev sync manifest (they were never in it, and no longer dark) | [C]       |
| **B**  | `points.rid`/`devices.rid` get `DEFAULT nextval(…)`; `setval(device_rid_seq, …)`          | 0043      |
| **C**  | `device_state` becomes the polling writer + reader; `polling_status` frozen                | [C]       |
| **G**  | `roles` dies; `area_bindings_role_check` is now the sole enforcement of the 6-role set     | 0044      |
| **F**  | `user_systems` + `isViewer` die (prod table was empty)                                     | 0045      |
| **A2** | Close the mint-only mirror leaks (`updatePoint`, `updateDashboard`, `updateSystem`)        | [C]       |
| **H**  | `area_devices` → `area_members`                                                            | 0046      |
| **D**  | `pointForAddr` **17 → 2** over two PRs; `pointUid` became a field on `PointInfo`           | [C] ×2    |
| **E1** | The `area_bindings` writers populate `point_uid` — closed a live defect                    | [C]       |
| **E2a**| 13 server-internal `area_bindings` readers onto `point_uid`                                 | 0047      |
| **E2b**| the area-builder wire → `pt_` TypeIDs, KV map re-keyed by point uuid, writers + contract     | 0048      |

Two of these carry findings that still bind:

- **Slice D's headline correction.** The plan sized `pointForAddr` as the long pole (~18 sites, backing
  store move). It was 17 → 2 in two PRs, because nearly every caller already held the uuid. The backing
  store never had to move — `points` has **no counterpart to `point_info.id`** (the per-device index), so
  `pointForAddr` cannot be served from `points` at all. **`SystemsManager` (slice K) is the real long
  pole.** The 2 remaining sites are structural, not mechanical: an admin route whose **URL segment** is
  the legacy address (Phase 13), and the receiver's `debug.reference` branch (slice M).
- **The parity gate.** `scripts/config-v4/verify-slice-d-parity.ts` drives the real new code paths and
  compares every identity against what `pointForAddr` would have returned. Baseline **451 identities, 0
  mismatched** on `liveone-dev`. Extend it per PR; a conversion that _moves_ an identity is a bug, not a
  new baseline. It survives slice M and dies in Phase 13 with the last `pointForAddr` caller.

### Slice E (remaining) — `area_bindings` off the int pair

`area_bindings_point_info_fk` is **the only remaining FK into `point_info`** and is therefore the single
sequencing constraint on the terminal `point_info` drop.

**Correction to this slice's own sizing.** The pair is not internal. It is also the area-builder's wire
grammar (`components/area-builder/types.ts:75-82`) and the KV subscription map's key
(`lib/kv-cache-manager.ts:97,162`) — both of which this plan assigned to Phase 13, and neither of which
can live there: the pair's second half is `point_info.index`, whose allocator dies at slice M and whose
table dies at the terminal window. The pair must die inside Phase 12.

- ✅ **PR 2a DONE** ([#281](https://github.com/simonhac/LiveOne/pull/281)) — 13 server-internal readers
  onto `point_uid`, including the two hand-written-`sql` sites and the `prod-dev-sync` conflict target
  (which had to precede 0047's index re-base). Verified: 137/137 suites (1,341 tests), tsc clean on app
  + `scripts/config-v4/`, `check:readings` green, `db:pg:generate` "No schema changes", parity gate at
  **451 identities / 0 mismatched** — unchanged, so the conversion moved no identity. The two raw-SQL
  sites were *driven* against dev, not compiled: `syncAreaBatteryConfigFromDevice` updated the owning
  Area alone (3 non-owning Areas untouched), and the coverage lookup A/B'd 0-differing across all 12
  bound device rids. Inventory corrections: `area-builder-smoke.ts` and
  `point-manager-area-of-one-parity.test.ts` needed no change (the latter mocks empty bindings, so the
  converted branch is unreachable), and two unlisted sites fell out — dead `powerPoint ? … : null`
  branches in `battery-provenance-pg.ts` that non-null `bindingPoint` exposed.
- ✅ **0047 APPLIED to BOTH environments (2026-07-29** — prod `sydney`, then `liveone-dev`). `point_uid`
  SET NOT NULL; `area_bindings_point_info_fk` dropped; `area_bindings_unique` re-based onto
  `(area_id, role, metric_type, point_uid)` and `area_bindings_point_idx` onto `(point_uid)`; both int
  columns relaxed to NULLable. The re-based unique index is strictly *stronger*, not merely equivalent —
  `point_uid` being NOT NULL means two bindings on one (area, role, metric) slot can no longer both slip
  through as NULL-distinct — which is why `SET NOT NULL` runs **before** the index is created.

  Pre-checked on prod directly under a short-TTL `pg_read_all_data` role (confirmed genuinely prod two
  ways: the role username carried the `91nbdvyn5o2z` branch token, and `point_readings` was 0 min
  behind, i.e. actively polling): **72/72 `point_uid` populated, 0 NULL, 0 disagreeing with the pair**,
  and `area_bindings_point_info_fk` was the sole FK into `point_info`. Both environments post-checked on
  the **database** rather than the migrate output: `point_uid` `attnotnull` true, the pair false/false,
  **FKs into `point_info` = 0**, 72 rows preserved, both indexes re-based, `slot_priority_unique`
  untouched, and the journal's newest hash `fc49ac9e…` byte-identical to local 0047. Ingest never
  paused — readings stayed ~27 s behind across the prod apply. The parity gate re-ran post-DDL at
  **451 identities / 0 mismatched**. Row inventories for both envs captured to `.context/backups/`
  beforehand, since the guard's `RAISE NOTICE`s are swallowed. Temp roles deleted; **no `reassign` was
  needed even though the migration CREATEs indexes — an index's owner always follows its table's**, so
  they came out owned by `postgres`.
- ✅ **PR 2b DONE** ([#284](https://github.com/simonhac/LiveOne/pull/284)) — the area-builder wire is
  `pt_` end to end and `parseReference` is gone; the KV subscription map's **source key** is the point
  uuid (its outer `subscriptions:system:N` key, `latest:system:N` and the stored `pointReference` stay
  integer by design until Phase 13, and say so in a comment); `replaceBindings` reads points by uuid and
  now validates membership against the **resolved** `point_info.system_id` rather than a caller-asserted
  one. Corrections to the brief: `updateLatestPointValue` keeps `(systemId, pointId, pointUid, …)` —
  dropping the ints is impossible while `latest:system:N` is integer-keyed; there are **six** production
  call sites, not three (`hws/recompute` and `run-tracking/running-latest` hold no `PointInfo`); and
  `getAreaBindings` had to gain a join because the source system id lived on a dropped column — it goes
  through `points → devices.rid`, **not** `point_info`, because slice N drops `point_info` before Phase
  13 retires the integer keyspace, and because both hops are FK-backed so neither can silently drop a
  binding.
- ✅ **0048 APPLIED to BOTH environments (2026-07-29).** Order matters and is the reusable part:
  merge → deploy `Ready` → **rebuild the KV registry on both envs** → verify multi-device areas serving
  fresh → apply prod → post-check → apply dev → post-check. All three guards were also run by hand on
  prod first. Both envs: pair columns gone, 72 rows, 0 NULL `point_uid`, **0 FKs into `point_info`**,
  journal hash `97aa697e…` matching local, `db:pg:generate` "No schema changes", parity gate **451/0**,
  ingest 7 s behind throughout. The KV rebuild was verified by re-running the *same* query before and
  after — prod's inner keys went `['4','5','6']` → uuids across 12 source systems. Final int-pair
  inventories are in `.context/backups/`; **unlike 0047, 0048 destroys data not reconstructible from
  the schema**, so those files plus PITR are the only copies.

**Why two migrations:** both int columns are `NOT NULL` with no default, so the instant the writers stop
naming them every binding INSERT fails until the drop. Expand/contract, not one flip.

**No `point_uid` → `point_id` rename.** Catalog-only and tempting, but `pointId` meaning `int` in one
commit and `uuid` in the next is a history hazard. It belongs with Phase 13/14's batch TypeID pass.

### Slice M — `point-manager` mints `points` directly [C], no migration

**The plan under-sized this: there are FOUR `max(index)+1` allocators, not one — and three never call
`mirrorPoint`.** `point-manager.ts:588-596` (mirrors), `hws/register.ts:80-100`,
`battery-provenance/register.ts:205-232`, `run-tracking/running-latest.ts:51-77` (none mirror). That is
slice A2's defect class one level out.

**Probed 2026-07-29: the hole is ARMED but has NOT FIRED.** `/api/health?v4mirror=1` reads
`pointsMissing: 0, devicesMissing: 0` on prod, and dev is 134 `point_info` = 134 `points`. The reason
is timing, not safety: the three unmirrored writers last minted in June (hws ×2, running ×1), before
the cutover's `registry-populate` backfilled `points` — so their rows have a mirror they did not
create. **The next mint through any of those three paths orphans a point**, and the hot tables'
`FK point_rid → points(rid)` still enforces on insert, so that reading fails and QStash retries it
forever. This is the same shape as slice E PR 1: a writer gap that is invisible until someone
exercises it. So M is **preventive**, and the probe must be re-run immediately before it starts.

**Invert: `points` becomes primary, `point_info` the write-behind copy until it drops.** 0043's
`points.rid DEFAULT nextval(…)` exists for exactly this and is inert until now; both columns draw from
one sequence, so the invariant is untouched. `point_info.index` is NOT NULL and half the PK, so give it
`index = rid` — globally unique, monotonic, and **the scan and its race both die outright**. Extract one
`mintPoint()` helper and route all four writers through it. Two consequences: `schema.ts:222-224`
("writers must NEVER name `rid`") becomes a lie and must move with the code, and `isPointUidCollision`
must also match `points_pkey`, or the retry-with-random-uid path silently dies.

M also retires the receiver's legacy `"{systemId}.{pointIndex}"` branch and its producer
(`publisher.ts`'s `debug.reference`). **G3 must be run by M at merge time**, not deferred to the
terminal window — and note `observations_outbox` is the *backup* leg, not the population, so pair the
content check with `min(created_at)` of unpublished rows and an empty DLQ. **After removal, a null
`pointUid` must be loud-but-skipping**: today it throws and retries; a naive deletion makes it return
null, which means silent skip — data loss. A throw re-creates the poison pill G3 exists to prevent.

**Proof:** the live dev exercise (mint a genuinely new point, follow poll → publish → receive →
aggregate → serve), `pointsMissing: 0` before and after, and a **concurrency test** — two simultaneous
mints of the same new tail, which is a PK violation under the old allocator.

### Slice K — `SystemsManager` → `DeviceRegistry` [C]

**One PR, not seven.** Every `systems` read already goes through the `deviceStateByHandle` subquery, so
the shape is fixed and the change is mechanical. Slice by **method**, not by file — `getSystem` alone is
34 of the 78 sites. Fix in passing: `createSystem` writes the `legacy_handles` row **twice**
(`systems-manager.ts:448` inside `insertSystemToPg`'s tx, then `:333` outside it).

### The collapsed terminal window — slices I + J + L + N in one pass

Designed 2026-07-29, replacing a staged expand/contract across 5 migrations. **Net cost: 1 PR, 1
migration, 2 applies.**

**Why the renames need no staging.** `devices.rid == systems.id` is asserted at three independent points
(`v4-mirror.ts:26` and `ensureDeviceRow`, which inserts `rid` as literally `s.id`; `schema.ts:1004-1006`;
the Phase 8 cutover doc). So `ALTER TABLE … RENAME COLUMN` is catalog-only, instant, no backfill.
Expand/contract was buying protection against a value migration that does not exist.

- `sessions.system_id` → `device_rid`; drop the old FK, add one → `devices.rid` **`NOT VALID` then
  `VALIDATE`** so the `ACCESS EXCLUSIVE` window is catalog-only and the ~870K-row scan runs under
  `SHARE UPDATE EXCLUSIVE`.
- `observations_outbox.system_id` → `device_rid`. It has no FK — **do not add one**: an outbox is a
  buffer, and an FK there turns a device delete into an ingest-path failure.

**The pause mechanism SURVIVED Phase 10 — do not rebuild it.** Phase 10 removed only the KV-flag half.
The QStash **queue pause** is live at `app/api/admin/observations/info/route.ts:80-86`
(`{"action":"pause"|"resume"|"set-parallelism"}`, `GET` → `{paused, lag, parallelism}`). It stops
_delivery_, not enqueue — this is how the entire us-east → Sydney move was done. **Do NOT try to drain
the outbox to zero**: impossible while polling, and unnecessary.

| #  | Step                                                                                                                                                                                                   | Gate                                                                                             |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0  | `pscale backup create` on `sydney` + confirm PITR. `gh workflow disable sync-prod-to-dev.yml`. Capture `GET /api/admin/observations/info` (record `parallelism`) and full row inventories to a local file. | backup id recorded                                                                               |
| 1  | `POST …/observations/info {"action":"pause"}`                                                                                                                                                           | **G1**: `paused:true`, then `max(sessions.created_at)` and `max(point_readings.measurement_time)` static across 60 s |
| 2  | **G2 — identity proof.** `sessions`/`observations_outbox` LEFT JOIN `devices d ON d.rid = …` WHERE `d.rid IS NULL` → 0 each; `systems` FULL JOIN `devices` with either side NULL → 0.                     | all three 0, or **abort**                                                                        |
| 3  | **G3 — poison pill.** Unpublished outbox rows with any observation missing `pointUid` → 0. (Already asserted by slice M; this is the re-assert.)                                                          | 0, or **abort**                                                                                  |
| 4  | **Merge + deploy the terminal build.**                                                                                                                                                                 | deploy `Ready` + aliased; `/api/health` 200                                                      |
| 5  | **Apply to prod** (short-TTL role, `ALTER ROLE CURRENT_USER SET lock_timeout = '5s'`).                                                                                                                  | migrator exits 0                                                                                 |
| 6  | **G4 — post-check the DATABASE:** `to_regclass` NULL ×3; `sessions` has `device_rid` and not `system_id`; the new FK present **and `convalidated`**; `device_rid_seq.last_value` ≥ old `max(systems.id)`; `point_rid_seq` ≥ `max(points.rid)`. | all pass                                                                                         |
| 7  | `set-parallelism` 1, then resume. Watch the first delivered message land.                                                                                                                               | a new `sessions` row with `device_rid`; `point_readings` advancing                                |
| 8  | Restore parallelism; `lag` → 0; DLQ empty.                                                                                                                                                             | lag 0, DLQ empty                                                                                 |
| 9  | **G5 — continuity.** Gap-check `point_readings` across the window.                                                                                                                                     | no gap > the vendor's own interval                                                               |
| 10 | Apply to `liveone-dev`, re-run G4, re-enable the sync workflow, watch one dispatch go green. Delete temp roles.                                                                                          | sync green                                                                                       |

**DDL order inside the migration** (one transaction — drizzle wraps all pending files):
(1) guard block re-asserting G2's three counts with `RAISE EXCEPTION` — the only version of the check
that cannot be raced between probe and apply; (2) `sessions` rename → drop old FK → add new `NOT VALID`
→ `VALIDATE`; (3) `observations_outbox` rename; (4) `DROP TABLE polling_status`, then `point_info`, then
`systems` — **no `CASCADE` on any of them**; (5) `setval` for `device_rid_seq` and `point_rid_seq`,
floored with `greatest(…)`, **last, after every guard** — `setval` is not transactional, so a stranded
one must be a no-op, not a corruption.

**The one unrecoverable loss path is stopped pollers** — vendors serve _latest_, not history, so a 2-hour
stop is 2 hours gone forever. `CRONS_ENABLED` stays `true` throughout; positive mid-window check is
`max(device_state.last_poll_time)` seconds old with `total_polls` climbing. During the deploy→DDL skew
`persistOutbox` will fail (the new build writes `device_rid` before the column exists) and is
_deliberately_ swallowed — that is fine, because the direct QStash enqueue is independent and the paused
queue buffers it. Keep steps 4→5 under ~10 min and confirm queue `lag` is still **climbing**; a flat lag
means the direct leg is failing too, which is an abort.

**Extra code items, easy to miss:** `lib/areas/handles.ts:31-33` (`allocateAreaHandle` reads
`max(systems.id)`); `app/api/observations/receive/route.ts:52-58` (`isSystemFiveMinuteNative` selects
`systems.vendor_type` → must read `devices.vendor`); `lib/readings/prod-dev-sync.ts:129,270` and
`lib/readings/preview-seed.ts:73-90`; `package.json:14,16` (the `prebuild` `tsc` step goes with
`scripts/config-v4/`).

**Done when:** zero query sites against any dropped table; `SystemsManager` deleted; a real poll →
publish → receive → aggregate → serve cycle green on `liveone-dev` **including a newly minted point**
(the C7 case); `db:sync-dev-db` exits 0 with every orphan-FK check at 0; `check:readings` green.

---

## Phase 13 — Kill the handle: TypeID-native serve path

**Goal:** delete `areas.legacy_system_id` and everything that reads an integer as an address. Depends on
Phase 12 (`DeviceRegistry` must already be the config API). One page by design — the owning agent
develops the detail.

- **Delete the synthesis** — `synthesizeAreaView`, `getViewableSystem`, `isAreaHandle`,
  `AREA_HANDLE_BASE`, `allocateAreaHandle`; route the 8 remaining call sites through
  `DeviceRegistry.resolveHandle`. **Precedence is device-first (locked)**, which is what today's
  real-row-first code already does, so this is behaviour-preserving. Keep
  `point-manager-area-of-one-parity.test.ts` as the gate.
- **Make the wire TypeID-native** — `/api/data` and `/api/history` accept `deviceId=dv_…` / `areaId=ar_…`;
  payload `system` → `device`. Demote `?systemId=N` to a **permanent compat alias** through
  `legacy_handles` (area first, else device). React Query keys move in lockstep.
- **Move the KV keyspace** to `latest:device:{dv_…}` / `latest:area:{ar_…}`; the SCAN regex requires
  `(\d+)` and must change with it. KV is disposable — rebuild rather than migrate.
- **The `systems`→`devices` code rename** — the URL cluster (~4,576 lines / 21 files) plus
  `point-manager.ts`. Mechanical but wide: ~296 files mention a config-sense `system`.
- **Drop `areas.legacy_system_id`**; keep `legacy_handles`. Fold the handle-era classes in
  `lib/identifiers/` that lose their callers — but **leave `logical-path.ts` and `point-uid.ts` alone**,
  they are orthogonal and still widely used.

**Done when:** zero `legacySystemId` / `AREA_HANDLE_BASE` / `isAreaHandle` / `synthesizeAreaView`;
`?systemId=N` still resolves for every handle in `legacy_handles`; KV holds only TypeID-keyed entries; a
`/dashboard/id/{n}` 301 still works. **Risk:** the KV move and the `/api/data` shape change are both on
the live serving path. Plugin props still carry `handle` — absorb that at the `v4-adapt.ts` boundary
rather than touching 19 plugins twice.

## Phase 14 — v4-native presentation, and the last of the two shapes

**Goal:** one dashboard shape. Delete the v3 descriptor, the rewriter, the adapter and the legacy route
handlers. Largest phase by volume; last because it depends on Phase 12's registries.

- **Port the 19 plugins to v4-native** — one `CARD_RENDERERS` keyed on `card-types.ts`' 18 unified types,
  replacing the split card (10) + tile (9) registries; then delete `v4-adapt.ts`.
- **Build the v4 editor** so the write model is v4; move the page shell onto the doc, make
  `temporal-cards.ts` v4-aware.
  > ⚠️ **A2's fix regenerates `doc` UNCONDITIONALLY, which is only safe while `doc` has no independent
  > author.** The moment this phase ships an editor that writes `doc` directly, a descriptor PATCH will
  > **clobber v4-authored structure** — so the editor work must turn this into a reject-or-merge
  > decision, not an overwrite. Dropping `descriptor` is the real fix.
- **Build the 10 missing `/api/v4` mutation endpoints**, then retire the 28 legacy handlers across 15
  routes. `/api/areas/[areaId]/default-section` is already a straight duplicate of its v4 twin.
- **Drop `dashboards.descriptor`**; delete `lib/dashboard/{v3,cards,v3-to-v4}.ts`, `v4-seed.ts`'s v3
  detour, and every `isDashboardV3`/`isDashboardV4` branch. Retire the bridge tests (~362 LOC).
- **Tighten to strict decode** — drop the dual-accept `areaRefToUuid` and the `rowToDashboard`
  read-normalize. Precondition MET (prod 100% `ar_` as of 2026-07-27); re-assert before dropping, since
  any dashboard created since must also be `ar_`. Fix the `/api/data` `vendorSiteId` raw-uuid leak.
- **Queued card work, unblocked here:** HWS 7-day stripe → a generic `daily-stripe` card, and the heatmap
  → a `heatmap` card. See [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md).
- **Close out** — delete the phase-7/8 docs and this file; fold anything still true into
  `docs/architecture/data-model.md`. Git is the archive.

**Risk:** the 19-plugin port is where visual regressions hide and there is no snapshot coverage. Port
plugin-by-plugin behind the still-present adapter and remove the adapter last, so each is independently
revertible.

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
- 🛑 **Never `pscale role reset-default` on prod.** It rotates the `postgres` password prod's
  Production-scope vars carry, and Vercel captures env at deploy time — prod 500s until redeployed.
  Unnecessary for a `[D]` slice: a drop migration creates no objects, so a temp role owns nothing.
- ⚠️ **Every migration goes to prod FIRST, then dev** — `prod-dev-sync.ts` reads columns at runtime, so a
  _dev_ column prod lacks trips the schema preflight. And **parallel workspaces collide on migration
  numbers**: `git fetch origin main` and check both the directory and the live journal before generating.
- ⚠️ **A dev-side check is only evidence about prod when the sync is demonstrably green.** Probe prod
  directly under a short-TTL read-only role, and confirm it really is prod two ways (the role username
  carries the prod branch token; `max(measurement_time)` is ~0 min behind, since dev's crons are off).
- ⚠️ **Hand-written `sql` fragments are invisible to tsc** — a rename or drop breaks them silently, so
  they must be *driven*, not compiled. (Bit slice H.) Likewise `scripts/config-v4/` is type-checked by
  `prebuild`, so a stale reference there fails the **Vercel build**, not just a local script.
- ⚠️ **Read the producer, not the consumer, before sizing a conversion.** Three of slice D PR 2's six
  sites already held the uuid and were never blocked at all.
- ⚠️ **A DELETE predicate must be driven POSITIVELY.** It fails silently in both directions —
  under-delete leaves a dangling row, over-delete removes a live one. `area-builder-smoke.ts` clears
  bindings *before* removing a member, so its `removeMember` call only ever ran the statement against
  zero rows: it proved the SQL parses, not that it selects the right rows. A two-member area with a
  binding on each is what actually proves it.
- ⚠️ **When a v4 column goes NOT NULL, the constraint is its WIRE-facing readers, not its internal
  ones.** Internal readers convert freely; the wire cannot until its grammar changes. That asymmetry is
  why a contract migration **relaxes** the legacy column instead of dropping it — the intervening state
  has to be representable, or two PRs collapse into one un-splittable change.
- 🛑 **Migration preconditions read the CATALOG, never the drizzle journal.** The journal records
  intent; the catalog records what is true of *this* branch. 0048 proves 0047 landed by checking that
  `area_bindings_unique` actually keys on `point_uid`.
- 🛑 **Re-assert an equivalence inside the migration that destroys your ability to check it.** After a
  DROP there is no second address left to disagree with, so a divergence introduced since the last
  check becomes silent and permanent. A check that can only ever run once should run.
- 🛑 **A column drop is only half the change when a persisted derived store keys off it.** The KV
  subscription registry had to be rebuilt on both environments *between* the deploy and the drop —
  that is a deploy step, and it belongs in the PR body and the migration header, not in the reviewer's
  memory.
- ⚠️ **Removing a FK turns any join onto the replacement key into a silent filter.** Prefer a
  replacement join that is itself FK-backed and NOT NULL; if none exists, add a reachability assertion.
- ⚠️ **When a check becomes DB-enforced, replace it with the next unenforced invariant, or delete it.**
  A passing tautology reads as coverage. The parity gate's block 0 went from "is `point_uid` non-null"
  (now enforced by 0047) to binding→`point_info` reachability.
- ⚠️ **A mocked query-builder chain encodes arity**, so re-shaping a query is a test change by
  construction — a stale chain returns `undefined` and yields zero rows *silently*. If re-shaping a
  query did not require touching its mock, the mock is not asserting anything.
- 🛑 **`scripts/config-v4/reconcile-device-state.ts` is SPENT** — a pre-flip tool whose direction is now
  backwards (`polling_status` is frozen while `device_state` advances), so `--commit` would rewind live
  counters. Its drift report is equally spent: post-flip the tables are _supposed_ to diverge. Check the
  writer by reading `device_state` directly.

## Open follow-up — run-interval statistics assume the signal IS power

`derived-intervals-pg.ts` writes `max/min/avg_power_w` as statistics of the **signal series**, whatever
it is. Fixed 2026-07-28 without a schema change (the route resolves the signal point's name/unit and
returns a server-computed `columns` plan; `avgPowerW` now comes from energy ÷ duration). **Deferred to
Phase 14:** rename `*_power_w` to something signal-neutral carrying a unit, which is what would retire
the `detector_version` gate now suppressing `avgSignal` for rows whose units predate the DSE re-point.
Prod's history is **mixed-unit and permanently so** — a dynamic "rpm" header would print pre-11-Jul
Watts as rpm. Cost/emissions columns are a separate, larger piece:
[run-period-provenance.md](run-period-provenance.md).
