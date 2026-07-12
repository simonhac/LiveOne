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
of grid-import price/cost/energy (2025-11-26 → 2026-07-12) is missing, degrading cost/emissions
attribution for the **Kinkora Unified area (area 8)**. **Not yet resolved** — the fix and backfill
are planned; this report will be updated once they land.

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

**Not yet implemented — planned.** This report will be updated once the fix and backfill land.

### The planned fix

1. Fix `derivePointKey` in `lib/vendors/amber/amber-readings-batch.ts` to **keep all segments**
   (join on `"."` instead of dropping the first): `"E1/perKwh"` → `"E1.perKwh"`. This restores
   channel-distinct keys and **simultaneously repairs** `getCanonicalDisplay()`, which already
   expects `E1.perKwh` / `grid.renewables`.
2. Update the tests in `lib/vendors/amber/__tests__/point-reading-group.test.ts`: the current
   fixtures feed the stale prefixed form `"amber/E1/perKwh"`, which masks the bug. Change them to
   the real production tail `"E1/perKwh"` and add a regression test — an interval carrying both
   `E1/perKwh` and `B1/perKwh` must yield **two** stored readings, not one.

### The planned backfill

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
- **2026-07-12** — investigation identifies the `derivePointKey` collision as root cause; fix +
  backfill planned.

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

## Action Items

- [ ] Ship the `derivePointKey` fix (keep all segments; join on `"."`) plus the regression test that
      a two-channel interval yields two stored readings.
- [ ] Update `point-reading-group.test.ts` fixtures to the real production tail (`"E1/perKwh"`, not
      `"amber/E1/perKwh"`).
- [ ] Run the backfill (`scripts/temp/backfill-amber-import.ts`) for system 9 pts 2/7/8,
      2025-11-26 14:00 UTC → present — **after** the fix is deployed/branched.
- [ ] Recompute `point_readings_agg_1d` for system 9 import points and re-run flow /
      battery-provenance / cost-attribution for area 8.
- [ ] Add a **silent-death monitor**: alert when a previously-live point stops receiving new
      intervals.
- [ ] Add a test asserting **every distinct Amber physical tail maps to a distinct batch key**.
- [ ] Verify recovery once backfill + recompute complete, and update this report.

## Status

- [x] Issue identified
- [x] Root cause determined
- [ ] Fix implemented
- [ ] Backfill executed
- [ ] Downstream recompute (agg_1d + area-8 cost/emissions)
- [ ] Verified
