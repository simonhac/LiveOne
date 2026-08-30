# Amber grid-import channel data loss — `derivePointKey` key collision

## Summary

On **2025-11-26**, all three **grid-import** channels for **system 9 (Amber Kinkora)** on prod
silently stopped writing and never recovered. Amber is a **5-minute-native** vendor, so it writes
readings to `point_readings_agg_5m` (via `insertPointReadingsAgg5m`), **not** `point_readings` —
which holds **0 rows** for system 9. (An earlier investigation "found nothing" because it queried
the wrong table.)

Root cause: a **Map-key collision** in `derivePointKey()`
(`lib/vendors/amber/amber-readings-batch.ts`). The helper strips the first segment of the physical
path, so import (`E1/…`) and export (`B1/…`) collapse onto the same key; within each interval
export overwrites import in the batch Map, and only the surviving (export) readings are persisted.
Import **price** (pt 2), **cost** (pt 7) and **energy** (pt 8) died; only export (pts 1/5/6), spot
price (pt 4) and renewables (pt 3) survived, because their post-strip keys are already unique.

This is a **silent data-loss** incident (no error, no availability impact). Roughly **7.5 months**
of grid-import price/cost/energy (2025-11-26 → 2026-07-12) went missing, degrading cost/emissions
attribution for the **Kinkora Unified area (area 8)**.

**Resolved.** The `derivePointKey` fix shipped in `a9f1cf7c` (PR #159) and live import data resumes
at **2026-07-12 14:30 UTC**; the backfill ran 2026-07-12 → 07-16 and restored the whole gap. Prod
was re-verified on **2026-07-25**: points 1/2/3/4/7/8 have **zero missing and zero partial AEST
days** from account start (2025-10-20) to 2026-07-24. The only residual hole is export cost + energy
(pts 5/6) on **2026-04-15/16/17**, which is out of Amber's ~90-day `/usage` window and recoverable
only from an Amber-support CSV.

## What Went Wrong

### The trigger — a path-shape refactor invalidated a helper's assumption

`derivePointKey()` derives the per-interval batch Map key by **stripping the first segment** of the
physical path. Its doc comment still assumes a 3-segment vendor-prefixed path
(`"amber/E1/perKwh" -> "E1.perKwh"`), where the stripped head is the vendor name and the surviving
`E1`/`B1` channel keeps import and export distinct.

That vendor prefix was **removed** when `physicalPath` became `physicalPathTail` (dropping the
vendor head) during the **2025-11-27→29 identity refactor** (commits `5b372f0`, `dbf3c41`, deployed
~2025-11-28 14:00 UTC). After the refactor the paths are `E1/perKwh` (import) and `B1/perKwh`
(export); stripping the first segment now removes the **channel**, not the vendor:

```
"E1/perKwh"  (import price) -> "perKwh"
"B1/perKwh"  (export price) -> "perKwh"   <- SAME KEY
```

### The failing code — last-write-wins in the batch Map

`AmberReadingsBatch.add()` uses the derived string as the per-interval Map key
(`this.records.get(timeKey)!.set(pointKey, …)`). Both feed paths in `lib/vendors/amber/client.ts` —
the usage path (`buildRecordsMapFromAmber`) and the prices path (`loadRemotePrices`) — add `E1`
(import) then `B1` (export) for each interval, so `Map.set` makes **export overwrite import every
interval**. `storeRecordsLocally` then persists only the surviving (export) readings to
`point_readings_agg_5m`; the import rows are never written. The same collision hits all three
metrics:

```
E1/perKwh  vs  B1/perKwh  -> perKwh   (price)
E1/cost    vs  B1/cost    -> cost     (cost)
E1/kwh     vs  B1/kwh     -> kwh      (energy)
```

The grid-level points survived because their post-strip keys are already unique:
`grid/renewables` → `renewables`, `grid/spotPerKwh` → `spotPerKwh`.

The 8 Amber points for system 9 and their status as of the 2026-07-12 investigation:

| pt  | channel / metric    | physical tail     | last interval        | status |
| --- | ------------------- | ----------------- | -------------------- | ------ |
| 1   | export price (rate) | `B1/perKwh`       | live (+forecast)     | LIVE   |
| 2   | import price (rate) | `E1/perKwh`       | 2025-11-28 14:00 UTC | DEAD   |
| 3   | renewables          | `grid/renewables` | live                 | LIVE   |
| 4   | spot price          | `grid/spotPerKwh` | live                 | LIVE   |
| 5   | export cost (value) | `B1/cost`         | live                 | LIVE   |
| 6   | export energy       | `B1/kwh`          | live                 | LIVE   |
| 7   | import cost (value) | `E1/cost`         | 2025-11-26 14:00 UTC | DEAD   |
| 8   | import energy       | `E1/kwh`          | 2025-11-26 14:00 UTC | DEAD   |

There is **no channel migration or re-mint** to hunt for: `point_info` holds exactly 8 Amber
points, and the unique index `pi_system_stem_metric_unique (system_id, logical_path_stem,
metric_type)` permits only one `(bidi.grid.import, rate)` row — point 2, the dead one. A prior
hypothesis that import-price "migrated to a new point id" was disproven.

### Two-stage death (proven by `data_quality` provenance)

The import channels died **two days apart**, which the `data_quality` provenance explains exactly:

- **Import cost + energy (pts 7/8)** are sourced **only** from the usage batch, so they died
  **2025-11-26** when the usage-batch collision deployed.
- **Import price (pt 2)** is **dual-sourced** — usage quality `b` (billing) plus prices quality
  `a`/`f` (actual/forecast). It **outlived** cost/energy by exactly **96 × 30-min intervals
  (2 days)**: as the usage source dropped out its `data_quality` walked `b` → `a,b` → `a,f` → `f`,
  until the prices-batch collision **also** deployed on **2025-11-28 14:00 UTC** and killed it
  entirely.

### Why it wasn't caught

- **A path-shape assumption baked into a helper.** `derivePointKey`'s "strip the first segment"
  stayed correct only while the path carried a vendor prefix. An unrelated upstream refactor changed
  the path shape and silently invalidated the assumption — the helper began stripping meaning (the
  channel) instead of noise (the vendor).
- **No test guarding channel-distinctness.** The fixtures in
  `lib/vendors/amber/__tests__/point-reading-group.test.ts` still feed the stale prefixed form
  (`"amber/E1/perKwh"`), which preserves the vendor head and masks the collision — the tests
  validate a path shape production no longer emits.
- **Silent loss, no error.** A Map-key collision drops rows with no exception, no DLQ and no gap
  alarm; the write simply never happens.
- **A live KV card masked the hole.** The dashboard import-price card reads via a KV path
  (`storeCurrentPeriodInKV`) that references `bidi.grid.import/rate` directly and bypasses the batch,
  so it likely kept showing a live current-period value despite the ~7.5-month gap in stored history
  — delaying detection for months.
- **Corroborating dead code.** `getCanonicalDisplay()` in the same batch file still calls
  `pointMap.get("E1.perKwh")` / `pointMap.get("grid.renewables")` — the old prefixed/dotted keys —
  so it currently matches nothing, another symptom of the same stale key assumption.

## Detection

Found by a **targeted investigation on 2026-07-12**, prompted by the observation that Amber
import-price history had gone dead. Prod was read with short-TTL `pg_read_all_data` roles (since
deleted); **no prod writes were made**. The initial confusion — an earlier look "finding nothing" —
was because it queried `point_readings` (0 rows for system 9) rather than `point_readings_agg_5m`,
where the 5-min-native Amber readings actually live.

## Resolution

**Shipped.** Fix in `a9f1cf7c` (PR #159, "Fix Amber import-channel key collision + add import
backfill tooling"); backfill tooling in `scripts/amber/` (`backfill-import-fetch.ts` →
`backfill-import-insert.ts`, plus `backfill-import-csv-to-chunks.ts` for history older than the
`/usage` window). Two backfill runs landed on prod:

- **2026-07-12** — `/usage` over its ~90-day window: 4,128 rows per import point covering
  2026-04-14 → 2026-07-12 (plus the matching 91 `point_readings_agg_1d` days).
- **2026-07-15/16** — the Amber-support CSV leg, covering 2025-11-26 → present.

Verified complete on prod 2026-07-25 (see Summary).

### The fix (as planned, and as shipped)

1. Fix `derivePointKey` in `lib/vendors/amber/amber-readings-batch.ts` to **keep all segments**
   (join on `"."` instead of dropping the first): `"E1/perKwh"` → `"E1.perKwh"`. This restores
   channel-distinct keys and **simultaneously repairs** `getCanonicalDisplay()`, which already
   expects `E1.perKwh` / `grid.renewables`.
2. Update the tests in `lib/vendors/amber/__tests__/point-reading-group.test.ts`: the current
   fixtures feed the stale prefixed form `"amber/E1/perKwh"`, which masks the bug. Change them to
   the real production tail `"E1/perKwh"` and add a regression test — an interval carrying both
   `E1/perKwh` and `B1/perKwh` must yield **two** stored readings, not one.

### The backfill

3. Backfill the lost import history for system 9, points 2/7/8, from **2025-11-26 14:00 UTC →
   present**, sourced from Amber's `/usage` endpoint (retained to account start) via the existing
   multi-day `updateUsage` sync, driven by a new `scripts/temp/backfill-amber-import.ts`. It is
   idempotent — `insertPointReadingsAgg5m` upserts on `(system_id, point_id, interval_end)`.

   > **Order matters:** the `derivePointKey` fix must be deployed/branched **first**, otherwise the
   > backfill re-drops import through the same collision.

4. Then recompute derived data: re-aggregate `point_readings_agg_1d` for system 9 import points, and
   recompute flow / battery-provenance / cost-attribution outputs for **area 8 (Kinkora Unified)**.

## Timeline (UTC)

- **2025-10-19** — Amber account start; all 8 channels (incl. import) flow correctly under
  channel-distinct keys (`E1.perKwh` ≠ `B1.perKwh`).
- **2025-11-26 14:00** — usage-batch collision deploys; **import cost (pt 7) + import energy (pt 8)
  go dead** (last stored interval).
- **2025-11-27 → 29** — identity refactor (`5b372f0`, `dbf3c41`) drops the vendor prefix from the
  physical path (`physicalPath` → `physicalPathTail`); deploy ~2025-11-28 14:00 (approx).
- **2025-11-28 14:00** — prices-batch collision deploys; **import price (pt 2) goes dead**, exactly
  2 days (96 × 30-min intervals) after cost/energy, its `data_quality` having walked `b` → `a,b` →
  `a,f` → `f`.
- **2025-11-28 → 2026-07-12** — ~7.5 months of missing grid-import price/cost/energy; the live KV
  import-price card likely still showed a current value, masking the gap.
- **2026-07-12** — investigation identifies the `derivePointKey` collision as root cause; fix
  (`a9f1cf7c`) shipped and the `/usage` 90-day backfill run. Live import data resumes **14:30**.
- **2026-07-15/16** — CSV backfill leg closes the pre-`/usage`-window history (2025-11-26 onward).
- **2026-07-25** — prod re-verified complete (0 missing / 0 partial AEST days for pts 1/2/3/4/7/8).
  A second look at the same question _on the `liveone-dev` mirror_ appeared to show the gap still
  open — a mirror artifact, not prod: the prod→dev sync watermarks on `max(updated_at) − overlap`
  read from dev and only moves forward, so the 2026-07-12 prod backfill (stamped `updated_at =
  2026-07-12`) was stranded and could never be copied. 12,888 system-9 rows were reseeded into dev
  by hand.

_(All times UTC; deploy times marked "approx" are approximate.)_

## Lessons Learned

1. **A path-shape assumption in a helper is a latent trap.** `derivePointKey`'s "strip the first
   segment" only worked while the path carried a vendor prefix. When an unrelated refactor changed
   the path shape, the helper silently started stripping meaning (the channel) instead of noise (the
   vendor). Helpers that parse structured strings should assert their shape, not assume it.
2. **Test with the real production shape.** The bug survived because fixtures used the stale prefixed
   form; the tests validated a path shape production no longer emits. Fixtures must track the real
   upstream contract, and a distinctness invariant ("each distinct physical tail → a distinct key")
   should be asserted directly.
3. **Silent channel loss needs its own alarm.** A Map-key collision drops rows with no error. A
   previously-live point that stops receiving new intervals should trip a monitor, independent of
   any single vendor's code path.
4. **A live cache can mask a dead history.** The KV import-price card bypassed the batch and kept
   showing a current value, so nothing looked wrong on the dashboard while ~7.5 months of stored
   history quietly went missing. "The current value is live" is not evidence the history is being
   written.
5. **Dual-sourced points partially mask failures.** Import price outlived cost/energy by two days
   because a second source kept it alive; the staggered death was a clue, but it also delayed a
   clean signal. Provenance (`data_quality`) is what made the two-stage failure legible after the
   fact.
6. **Close the report when the fix lands.** The fix and backfill shipped on 2026-07-12/16 but this
   document still read "Not yet resolved" on 2026-07-25. A stale doc plus a short dev mirror was
   enough to re-open a solved incident and burn an investigation cycle.
7. **The dev mirror is not evidence about prod.** `liveone-dev` is eventually consistent for _new_
   data only: the sync's watermark (`max(updated_at) − overlap`, read from dev) never looks
   backwards, so a historical backfill applied to prod is invisible to dev forever. Any
   "is the data there?" question must be answered against prod.

## Action Items

- [x] Ship the `derivePointKey` fix (keep all segments; join on `"."`) plus the regression test that
      a two-channel interval yields two stored readings. — `a9f1cf7c` (PR #159)
- [x] Update `point-reading-group.test.ts` fixtures to the real production tail (`"E1/perKwh"`, not
      `"amber/E1/perKwh"`).
- [x] Run the backfill for system 9 pts 2/7/8, 2025-11-26 14:00 UTC → present — **after** the fix is
      deployed/branched. — `scripts/amber/backfill-import-*.ts`, 2026-07-12 and 07-15/16.
- [x] Recompute `point_readings_agg_1d` for system 9 import points and re-run flow /
      battery-provenance / cost-attribution for area 8.
- [ ] Recover export cost + energy (pts 5/6) for **2026-04-15/16/17** — outside the `/usage` window,
      needs an Amber-support CSV.
- [ ] Add a **silent-death monitor**: alert when a previously-live point stops receiving new
      intervals. _(Still open — this is what would have caught the incident in November.)_
- [ ] Add a test asserting **every distinct Amber physical tail maps to a distinct batch key**.
- [ ] Give the prod→dev sync a reconcile leg so a prod-side historical backfill reaches the mirror
      (see Timeline 2026-07-25 and `docs/sync-prod-to-dev.md`).

## Status

- [x] Issue identified
- [x] Root cause determined
- [x] Fix implemented — `a9f1cf7c` (PR #159)
- [x] Backfill executed — 2026-07-12, 2026-07-15/16
- [x] Downstream recompute (agg_1d + area-8 cost/emissions)
- [x] Verified — prod, 2026-07-25: 0 missing / 0 partial AEST days for pts 1/2/3/4/7/8
      (2025-10-20 → 2026-07-24); residual 3-day hole on pts 5/6
