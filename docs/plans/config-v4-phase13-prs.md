# Config v4 Phase 13 — the six PRs, in orchestrator detail

> **Status: READY TO START (written 2026-07-30, immediately after Phase 12 completed).** Companion to
> [config-v4-execution-plan.md](config-v4-execution-plan.md) §Phase 13, which states the goal in one
> page. This file is the _implementation_ detail: one section per PR, each self-contained enough that an
> agent with no prior context can execute it.
>
> **Read before starting anything:** the **Traps and rules** section of the execution plan. It is not
> background reading — several entries there are the direct cause of a prod outage, and at least three
> of them apply to every PR below.

## How to use this document

Each PR section has the same five parts, and they are load-bearing:

| Part          | What it is for                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| **Goal**      | One sentence. If the PR does more than this, it has scope-crept — split it.                                   |
| **Inventory** | The measured file:line list. Re-measure before starting (see below) — do not trust these numbers blind.       |
| **Steps**     | Ordered, concrete edits.                                                                                      |
| **Proof**     | What must be true before opening the PR. Each PR has a _different_ proof — that is why they are separate PRs. |
| **Do NOT**    | The specific ways this PR goes wrong.                                                                         |

## 🛑 Standing rules for every PR in this phase

1. **Re-measure the inventory first.** Every count in this document was measured at `d16429fa` on
   2026-07-30. This document was itself nearly written against a tree one commit stale — the counts
   would have been wrong in a way that looked authoritative. **`git fetch origin main && git log --oneline -1`
   and re-run the greps** before you plan your edits.
2. **Never push to `main`.** Branch off `main`, `gh pr create --base main`. No exceptions, including for
   a one-line fix.
3. **`tsc` is blind to raw SQL and to string-built keys.** This is _the_ most reliable failure mode of
   this migration — **it bit six times in Phase 12 alone**, including twice after a fully green build.
   Every PR here must **hand-run a raw-string grep** for what it changed, and must **drive** the changed
   path, not merely compile it.
4. **Exercise WRITERS, not just readers, at the end of a slice.** A prod device-create bug hid for three
   days behind an `ON CONFLICT … coalesce` because only read paths were driven.
5. **A doc comment describing dispatch order is a CLAIM about code, not a fact.** `resolveHandle`'s
   docstring said "area-first" and was simply wrong. Verify before following any comment.

## The standing verification bar

Green baseline measured on `d16429fa`, 2026-07-30 — **this is what "unchanged" means**:

```
npm test              →  138 suites, 1347 passed, 5 skipped (1352 total)
npm run type-check    →  exit 0
npm run check:readings →  "readings boundary green — zero exceptions"
npm run check:routes  →  exit 0
npm run build:local   →  succeeds   (NOT `npm run build` — that fights the dev server)
```

Every PR must restore all five. A PR that changes the test count must say **why** in its body.

**Do not kill the dev server to check types** — it already runs `tsc --noEmit --watch`; look for the
`[1]`-prefixed lines.

## 🛑 Sequencing — CORRECTED, and the correction is the point

The execution plan lists "delete the synthesis" first and calls it behaviour-preserving. **Both are
wrong, and measurement is what showed it.** The corrected order is:

```
PR 1  area-native serving + wire TypeID   ← ENABLER; the synthesis cannot die before this
PR 2  delete the synthesis
PR 3  KV keyspace → TypeID
PR 4  systems→devices mechanical rename    ← must follow PR 2 (see below)
PR 5  convert ~55 readers onto legacy_handles + rewrite the sync drift key
PR 6  stop writing the column + migration 0052 DROP
```

**Why PR 1 and PR 2 swapped.** Multi-device areas have **no `devices` row** — they are served _only_
through `synthesizeAreaView`, a fabricated device-shaped view. `viewableByHandle`'s own docstring
(`lib/registry/device-config.ts:425-433`) says area-first ordering "belongs to Phase 13, **where areas
are addressed as areas**". So the synthesis is deletable only _after_ an area-native path exists. Delete
it first and you 500 every multi-device area.

Measured on the dev mirror — **four handles depend on the synthesis**, and one is a trap:

| Handle  | Name            | Members | Has `devices` row           |
| ------- | --------------- | ------- | --------------------------- |
| 7       | Craig Unified   | 4       | **no**                      |
| 8       | Kinkora Unified | 7       | **no**                      |
| 1000001 | Kuti House      | 1       | **no**                      |
| 1000002 | Daylesford      | 4       | **no**                      |
| **13**  | **Kutis**       | **3**   | **yes — the D-l collision** |

**Handle 13 is both a real Sigenergy device and a 3-member area.** `resolveHandle` states _no_
precedence and can return both legs; two existing callers impose **opposite** precedence
(`viewableByHandle` device-first/LOCKED, `resolveAreaIdForHandle` area-first). Routing naively through
`resolveHandle` silently widens handle 13 from its device's own points to the area's bindings — a scope
change on a **shared dashboard**, in the direction that removes access. That is trap D-l.

**Why PR 4 must follow PR 2.** `synthesizeAreaView` / `isAreaHandle` / `getViewableSystem` are slated for
**deletion**, not renaming. A mechanical rename that runs first produces `getViewableDevice` — the wrong
end state, and it makes PR 2's diff unreadable.

**Why PR 5 and PR 6 split.** Expand/contract, and the drop rule below.

**PR 6 is last because drops invert the ordering rule.** The additive rule is "migration leads code to
prod"; for a DROP it is the reverse — **the code that stops referencing the column must be deployed
first**, because a projection-less `.select()` expands to the columns declared in the _running_ build.
PRs 1–5 are that code. (Learned by breaking prod during 0037.)

**Land PR 1 and PR 3 separately, with at least one poll cycle between them.** They are adjacent on the
same live serving path. If the payload shape breaks you want to know that before the cache keyspace
moves underneath it.

## What this phase does NOT need

**No maintenance window.** Unlike Phase 12's terminal window, `areas.legacy_system_id` is a **nullable**
column on a 22-row table, off the hot path. No queue pause, no backlog drain, no G1–G5 continuity gates.
The only DDL complication is the `areas_legacy_system_unique` index, which drops with it.

**The drop is provably lossless.** Verified on the dev mirror: 22 areas, 22 with a handle, and
**0 area handles missing from `legacy_handles`** — every write path fills both in the _same
transaction_ (`lib/areas/create.ts:119-136`, `lib/registry/device-writer.ts:185-229`). The handle→area
map survives the column. One call site has already been converted and independently verified 22/22
(`lib/registry/device-config.ts:398-410`) — copy that pattern.

**The risk in this phase is PR 1, PR 3 and PR 5 — the live serving path and the sync — not the DDL.**
Budget review attention accordingly.

---

# PR 1 — Area-native serving + TypeID on the wire

**Goal:** `/api/data` and `/api/history` accept `deviceId=dv_…` / `areaId=ar_…`, and an **area** is served
from its own `areas` row instead of a fabricated device-shaped view.

**This is the enabler for PR 2 and the highest-risk PR of the phase.**

### The key measurement that makes this cheap

Every field the synthesized view supplies is **already a real `areas` column** — `ownerUserId`, `status`,
`name`, `slug`, `location`, `timezoneOffsetMin`, `displayTimezone`, `createdAt`, `updatedAt`
(`lib/registry/device-config.ts:372-396`). Only four are invented filler: `vendorType: "area"`,
`vendorSiteId: "area:{handle}"`, and `model`/`serial`/`metadata`/`config` as `null`.

**So the area branch is nearly free — do NOT let it grow into an int→uuid migration of the interior.**

### 🛑 Scope boundary — read this twice

**Keep the integer handle as the INTERNAL data-addressing key in this PR.** These are all still
int-keyed and are explicitly _out of scope_ here:

- the KV latest cache (`getLatestPointValues(system.id)`) → **PR 3**
- `point_readings` / `agg_5m` / `agg_1d` addressing and `SystemIdentifier.fromId` → later
- `PointManager` dispatch, `resolveLogicalSystem(systemId: number)`, `getPollingStatus(systemId: number)`

The wire becomes TypeID-native; the interior does not. Resolve `ar_…`/`dv_…` → handle at the edge via
`legacy_handles` and pass the handle inward exactly as today.

### Steps

1. **Add an area branch to `buildSystemPayload`** (`lib/dashboard/serve-data.ts:69-117`): when the
   request names an area, populate the payload from the `areas` row directly. `vendorType` becomes a
   real discriminator rather than the `"area"` sentinel; `pollingStatus` already resolves to `null`
   naturally via `getPollingStatus(handle)` (a `devices ⋈ device_state` join that misses for a pure area),
   and `commissionedOn` is not read on this path at all — confirm both rather than special-casing them.
2. **Accept `areaId=ar_…` / `deviceId=dv_…`** on `/api/data` and `/api/history`. Keep `?systemId=N` as a
   **permanent** alias, resolved **DEVICE leg first, else area**.
   🛑 **Corrected in PR 1 — this line originally said "area leg first, else device", which contradicted
   the Proof gate ten lines below.** For a COLLIDING handle (13) the two cannot both hold: area-first
   widens it from its device's own 12 points to its area's bindings, which is exactly what the gate
   forbids. Device-first is also the behaviour-preserving order (it is what `viewableByHandle` does
   today). The area-native reading of a colliding handle is reachable through the new explicit `ar_…`
   address — that is the whole point of putting TypeIDs on the wire, rather than silently
   reinterpreting an old integer. Precedence is now written down per call site in
   `lib/dashboard/subject.ts`.
3. **Rename the payload key `system` → `device`** only where it genuinely means a device. Where it means
   an area, emit `area`. Update the response TS types.
4. **Move the React Query keys in lockstep** (`lib/queries/keys.ts`, `SystemIdLike`). A stale key against
   a new payload shape is a silent cache-poisoning bug, not a compile error.

### Proof — a contract diff plus the five named handles

- Drive **all five** handles from the table above end to end on dev: **7, 8, 1000001, 1000002** (the
  synthesis-dependent areas) and **13** (the collision).
- **Handle 13 must return its DEVICE's own points, not the area's bindings.** Assert the point count
  does not change. This is trap D-l and it is the single thing most likely to go wrong.
- Diff the `/api/data` and `/api/history` payloads before/after for each handle. Only the intended keys
  may move.
- `?systemId=N` must still resolve for **every** handle in `legacy_handles` (22 on dev).

### Do NOT

- **Do NOT route through `resolveHandle` without stating precedence.** It returns both legs and states
  none. `viewableByHandle` is device-first and LOCKED; `resolveAreaIdForHandle`
  (`lib/derivations/resolve.ts:116-129`) is area-first. Pick explicitly, per call site, in code.
- **Do NOT migrate the KV keyspace here.** That is PR 3, and combining them puts two live-serving-path
  changes in one diff.
- Do not delete `synthesizeAreaView` yet — PR 2 does that, once this PR has removed its readers.

---

# PR 2 — Delete the synthesis

**Goal:** remove `synthesizeAreaView`, `viewableByHandle`, `isAreaHandle` and the now-orphaned
`fetchAreaForHandle`, because PR 1 gave areas a native path.

### Inventory (measured at `d16429fa`)

| Symbol               | Where                                                    | Call sites                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synthesizeAreaView` | `lib/registry/device-config.ts:372-396` (module-private) | 1 — `:441`                                                                                                                                                                              |
| `viewableByHandle`   | `lib/registry/device-config.ts:435-442`, exported `:452` | 7 prod: `lib/api-auth.ts:215,234,267`; `lib/aggregation/logical-system.ts:83`; `lib/point/point-manager.ts:457`; `lib/dashboard/serve-data.ts:203`; `scripts/area-builder-smoke.ts:127` |
| `isAreaHandle`       | `lib/registry/device-config.ts:445-448`, exported `:453` | 3 prod: `lib/api-auth.ts:232`; `lib/point/point-manager.ts:356`; `scripts/area-builder-smoke.ts:124`                                                                                    |
| `fetchAreaForHandle` | `lib/registry/device-config.ts:407-418`                  | 2 — both of the above; orphaned when they go                                                                                                                                            |

🛑 **`getViewableSystem` DOES NOT EXIST.** The execution plan names it, but slice K3 renamed it to
`viewableByHandle`. The only survivors of the old name are comments and a local test variable. **Do not
go looking for it.**

🛑 **`AREA_HANDLE_BASE` and `allocateAreaHandle` are NOT part of this PR.** The plan lumps them in, but
they are the _write-side allocator_ (`lib/areas/handles.ts:29,36-46`), not the read-side synthesis.
Areas still need a handle minted at creation while `areas.legacy_system_id` exists. **They die in PR 6.**

### Steps

1. Delete the four functions and their exports; update the module header comments (`:25-29,103-111,360`).
2. Repoint the 10 production call sites onto `deviceByHandle` (device leg) or the PR 1 area path.
3. `lib/point/point-manager.ts:356` is **not mechanical** — this is the structural dispatch between
   "load own points" and "resolve via bindings/union". Multi-device areas must keep the union path; the
   predicate needs an explicit device-first check, not deletion.
4. `getActivePointsForSystem` (`:457`) only reads `.id` off the view — simplify it to take the handle.

### Proof

Same five handles as PR 1, same assertion on handle 13. Plus: `npm test` must still be **138 suites**
or the PR body must explain the delta — see below, because a delta is expected here.

### Tests that must change

- `lib/point/__tests__/point-manager-area-of-one-parity.test.ts` — **its premise dies with the gate.**
  It proves parity between two resolution strategies; with one strategy left there is nothing to compare.
  Delete or rewrite it deliberately. Do not "fix" it into a tautology — a passing tautology reads as
  coverage.
- `lib/point/__tests__/point-manager-agg5m-publish-gate.test.ts:57-61` — trim the mock.
- `lib/aggregation/__tests__/logical-system.test.ts` — mocks `viewableByHandle` wholesale.
- `lib/__tests__/api-auth.test.ts:23-29,41,67-69` — same.
- `scripts/area-builder-smoke.ts` — the whole script exists to assert this behaviour; rewrite or delete.

---

# PR 3 — KV keyspace → TypeID

**Goal:** `latest:system:N` → `latest:device:{dv_…}` / `latest:area:{ar_…}`, and the same for
`subscriptions:system:N`.

### 🛑 Close the split-brain first

There are **four key-builder definitions across three files for two key families**:

```
lib/kv-cache-manager.ts:48    latest:system:${systemId}
lib/kv-cache-manager.ts:55    subscriptions:system:${systemId}
lib/latest-values-store.ts:45 latest:system:${systemId}        ← duplicate
lib/system-summary-store.ts:188 subscriptions:system:${systemId} ← duplicate
```

**Migrate one and miss another and the cache silently splits** — writes land under the new key, reads
come from the old. **Step 1 of this PR is to collapse these to a single owner**, before changing any key
format. Do this as its own commit so the collapse is reviewable on its own.

### Two integer-keyed families the plan never mentions

- **`oe:sched:system:{id}`** (`lib/vendors/openelectricity/scheduler.ts:174-175`) — poll-scheduler EWMA
  state. Same class of key. Decide explicitly: migrate, or leave and document why.
- **`{env}:system-summaries`** (`lib/system-summary-store.ts:49-51`) — the _key_ is constant, but every
  **hash field name** is the integer id. Same currency, different shape.

State the decision on both in the PR body. Silence reads as "covered".

### Also in scope

- The one regex: `/subscriptions:system:(\d+)$/` (`lib/kv-cache-manager.ts:265`) — `(\d+)` will not
  match a TypeID.
- The string-strip extraction (`app/api/systems/subscriptions/route.ts:70-75`).
- The `"{handle}.{ordinal}"` reference strings split on `.` (`kv-cache-manager.ts:123-124`,
  `system-summary-store.ts:214-216`).
- Six writers calling `updateLatestPointValue`: `lib/vendors/openelectricity/adapter.ts:234`,
  `lib/vendors/amber/adapter.ts:253`, `lib/point/point-manager.ts:980`, `lib/hws/recompute.ts:102`,
  `lib/db/planetscale/battery-provenance-pg.ts:478`, `lib/run-tracking/running-latest.ts:66`.
- Tests bake literal key strings: `lib/__tests__/kv-cache-manager.test.ts` (107,169,175,213,261),
  `lib/__tests__/system-summary-store.test.ts:166`, `lib/__tests__/kv-cache-manager.integration.test.ts`.
- `docs/architecture/kv-store.md` documents the old scheme and is already stale — rewrite it.

### Proof — this is the one with a deploy step

🛑 **A column/key change is only half the change when a persisted derived store keys off it.** The KV
registry must be **rebuilt on both environments between deploy and use** — that is a deploy step, and it
belongs in the PR body and the migration header, not the reviewer's memory. (This is the 0048 lesson.)

- `npm run db:rebuild-dev-kv` on dev; `npx tsx scripts/build-subscription-registry.ts` for the registry.
- Verify by running the **same query before and after** and diffing the inner keys — in 0048 prod went
  `['4','5','6']` → uuids across 12 source systems. Expect the analogous shape change here.
- KV is disposable: **rebuild, never migrate in place.**

---

# PR 4 — The `systems`→`devices` mechanical rename

**Goal:** rename config-sense `system` to `device` in code. **Purely mechanical — no behaviour change.**

**Must follow PR 2**, or a rename script turns doomed symbols into `getViewableDevice`.

### Scope (re-measured at `d16429fa`)

- **The URL cluster: 23 files / 4,853 lines** — the plan's "21 files / ~4,576 lines" undercounts. Use a
  fresh `grep -rlE "\b[Ss]ystems?\b"` as ground truth, not either number.
- 🛑 **There are TWO parallel route trees** and it is easy to convert one and miss the other:
  - `app/api/system/[systemId]/…` (singular) — points, point, run-periods, series
  - `app/api/systems/[systemId]/…` (plural) — credentials, location, tesla/command, subscriptions
- Whole-word footprint: **~290 files excluding tests, ~330 including**.
- Highest-leverage single file: **`lib/vendors/types.ts:93-133`** — the `VendorAdapter` interface all
  nine adapters implement. Renaming it forces every adapter's signature to follow.
- **`DeviceWriter.{createSystem, updateSystem, deleteSystem}` ARE in scope** — the file's own comment
  (`lib/registry/device-writer.ts:405-411`) says _"Phase 13 re-grammars the whole handle vocabulary at
  once."_ Easy to misfile as "keep" by pattern-matching the surrounding v3-compat language.

### 🛑 The DO-NOT-RENAME list — a blind `sed` corrupts every one of these

| Keep                                                                                              | Why                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`subsystem`** — DB column, every vendor `point-metadata.ts`, `SUBSYSTEM_CONFIG`, `SubsystemKey` | A _point category_ (solar/battery/grid/load). Unrelated entity. `sed s/system/device/` yields `subdevice`.                                                                                                                                                                                                                                   |
| `?systemId=N` on 8 routes                                                                         | Permanent compat alias (PR 1 demotes it; it does not disappear).                                                                                                                                                                                                                                                                             |
| `areas.legacy_system_id`, `[legacySystemId]` route param, `legacy_handles.handle`                 | Sanctioned permanent shim / dropped in PR 6.                                                                                                                                                                                                                                                                                                 |
| `PointReference`'s `"{systemId}.{pointId}"` grammar                                               | Legacy wire address, still live in `/api/history`.                                                                                                                                                                                                                                                                                           |
| **`QueueMessage.systemId` / `.systemName`** (`lib/observations/types.ts:126,129`)                 | Serialized to QStash JSON. **A rolling deploy has old and new builds live at once** — rename the key and in-flight messages break.                                                                                                                                                                                                           |
| `LatestValue.sourceSystemId` (`lib/latest-values-store.ts:29`)                                    | Explicitly **persisted in KV**.                                                                                                                                                                                                                                                                                                              |
| All `*:system:*` KV key strings                                                                   | PR 3's job, not this one.                                                                                                                                                                                                                                                                                                                    |
| **Vendor-literal fields**                                                                         | Enphase `system_id` (`lib/vendors/enphase/types.ts:17,38`); Sigenergy `d.systemId` + `?systemId=` URL param (`sigenergy-client.ts:490,516`); Selectronic `systemNumber` (`selectronic-client.ts:59,220,312-372,410`); Fronius `?Scope=System` (`packages/usher/clients/fronius/inverter.ts:337`). **These are other people's API grammars.** |
| Share-token phrases, slugs, `/dashboard/id/{n}`                                                   | Public/persisted strings.                                                                                                                                                                                                                                                                                                                    |
| Six independent local `interface SystemInfo` declarations                                         | Not one type with six importers — six unrelated types. Confirm before a global rename.                                                                                                                                                                                                                                                       |

**Stale prose naming the dropped tables** (e.g. `point-manager.ts:105` referencing `point_info.system_id`)
needs _editing_, not substitution — a sed produces comments describing columns that never existed.

### Proof

The verification bar, plus a **zero-behaviour-change argument**: the diff should contain no logic
changes at all. If `npm test` output changes in any way other than renamed test titles, something
non-mechanical crept in — split it out.

---

# PR 5 — Convert the readers onto `legacy_handles`, and rewrite the sync drift key

**Goal:** nothing reads `areas.legacy_system_id` any more. **This is the big one — I under-sized it
earlier as "small".**

### Scope

**~55 call sites across ~25 files.** The conversion pattern is already proven at
`lib/registry/device-config.ts:398-410`, which was swapped onto `legacy_handles` and **verified 22/22
areas agreeing** before the flip. Copy that, including the verification.

Start with the shared primitives, because many routes call them:
`lib/areas/resolve.ts:24,41` (`getAreaForSystem`, `getLegacySystemIdForArea`).

Then: `lib/areas/{handles,bindings,members,list,http}.ts`, `lib/derivations/resolve.ts:143`,
`lib/registry/device-writer.ts:363`, `lib/battery-provenance/*` (7 sites),
`lib/db/planetscale/battery-provenance*.ts` (3), `lib/grid/context.ts:55`, `lib/coverage/runner.ts:406-417`
(raw SQL), and 8 API routes including `app/api/areas/by-handle/[legacySystemId]/route.ts`, whose entire
purpose is this resolution.

Also `lib/areas/handles.ts:43` — `allocateAreaHandle` must compute `max(legacy_handles.handle)`.

### 🛑 The hardest single item in the phase: the prod→dev sync

`lib/readings/prod-dev-sync.ts:172-208` uses `legacy_system_id` as the **cross-environment natural key**
for `areas`, because area uuids are minted per-environment:

```
idDrift: {
  uniqueKeys: [ ["legacy_system_id"], ["owner_user_id", "slug"] ],
  neutralize: ["legacy_system_id", "slug"],
}
```

These become **literal SQL strings** at runtime (`d.legacy_system_id = s.legacy_system_id`, and an
`UPDATE … SET legacy_system_id = NULL`) — invisible to `tsc`, so they fail in production, not at build.

**The fallback key does not work.** Measured on dev: **16 of 22 areas have a NULL `slug`**, so
`["owner_user_id", "slug"]` cannot discriminate 73% of areas on its own. Dropping the column without a
replacement key leaves the sync unable to detect drift for most areas — silently.

`idDrift.uniqueKeys` currently assumes the key lives **on the drifting table**. Keying on
`legacy_handles.handle` is a **manifest-shape change** (cross-table), not a rename. Scope this first; if
it is large, split it into its own PR rather than letting it ride along.

`lib/readings/__tests__/prod-dev-sync.test.ts:269,285,306-308,346,494` pins this manifest and the SQL
ordering — update in lockstep.

### Proof

Run `npm run db:sync-dev-db` end to end and confirm **exit 0 with every orphan-FK check at 0**. Then
deliberately create a drifted dev area and confirm drift is still _detected_ — a sync that silently
stops detecting drift looks identical to a sync with nothing to do.

---

# PR 6 — Stop writing the column, and drop it (migration 0052)

**Goal:** the column goes.

### Steps

1. Stop writing it: `lib/areas/create.ts:127` and `lib/registry/device-writer.ts:198`. Both write it in
   the **same transaction** that calls `ensureAreaForHandle` — keep the `legacy_handles` half.
2. Delete `AREA_HANDLE_BASE` / `allocateAreaHandle` (`lib/areas/handles.ts`) if no handle is minted any
   more — decide explicitly and say which in the PR body.
3. Write **migration 0052** in the 0051 house style, which is the worked example to copy
   (`drizzle-planetscale/0051_terminal_drop_systems_point_info_polling_status.sql`).

### The migration

One `DO $$ … RAISE EXCEPTION` block reading **`pg_catalog`, never the drizzle journal**, asserting:

- every `areas.legacy_system_id IS NOT NULL` row has a matching `legacy_handles` row with the same
  `handle` **and** `area_id` — the identity proof, mirroring 0051's asymmetric G2 (**assert only the
  losing direction**)
- zero unexpected dependents on the column (`pg_constraint` scoped by `conrelid`)
- the column and `areas_legacy_system_unique` both still exist (catches a partial apply)

Then `DROP INDEX "areas_legacy_system_unique"` and `ALTER TABLE areas DROP COLUMN legacy_system_id`.
**No `CASCADE` anywhere** — an unexpected dependent must abort, not vanish.

There is **no FK** on the column today (`0014_eminent_kid_colt.sql:36` dropped the last one) and no
migration since 0014 has touched it.

### Apply procedure

Standard manual migration, **no window**: merge → deploy `Ready` → apply prod → post-check the
**catalog** → apply dev → post-check → `db:pg:generate` must say _No schema changes_. Use a short-TTL
`pscale role` with `lock_timeout`, then delete it.

### 🛑 Do NOT confuse this with `/dashboard/id/{n}`

The execution plan's "done when: a `/dashboard/id/{n}` 301 still works" is about **`dashboards.legacy_id`
— a different column on a different table** (`app/dashboard/[...slug]/page.tsx:312-327`). Nothing in
this PR touches it. It is a fine smoke test; it is not a gate on this drop.

---

## Close-out for the phase

Update [config-v4-execution-plan.md](config-v4-execution-plan.md): move Phase 13 into the shipped table,
strike its rows from _Still v3_, and fold any trap learned here into **Traps and rules**. Then delete
this file — git is the archive.
