# Kinkora Fronius energy halved, 11–30 August 2026

**Status:** code fix ships with this write-up; the hub redeploy and the prod data repair are
tracked below. Nothing alerted: it was found on 2026-09-22, while comparing Mondo's integrated power with
Amber's bill.

## Summary

From about 11 August to the evening of 30 August 2026, every energy-interval point the Kinkora
Fronius hub source (`fusher`, LiveOne device 5) pushed landed at **exactly half** its true value:
`solarWhInterval`, `loadWhInterval`, `batteryInWhInterval`, `batteryOutWhInterval`,
`gridInWhInterval`, `gridOutWhInterval` (rids 43–48). Power points were unaffected in value, but each
5-minute row folded ~2.5 raw readings instead of 5.

Row counts stayed at 288 a day throughout, so `device coverage` reported 100% and nothing noticed.
The coverage-repair cron does not cover push vendors either.

## What happened

1. **Deployed from a branch.** The hub (`liveone-flyhub`) was deployed by hand on about 10–11
   August from the #372 branch (the "TEMPORARY … 2026-08-10" musher note in
   `packages/usher/usher.example.yaml` dates it), about three weeks before that branch merged on
   29 August. The hub has no CI, so whatever branch is checked out when someone runs
   `fly deploy` is what runs.
2. **The branch split poll from delivery** (`tickOnce` → `shouldDeliver` in
   `packages/usher/core/run.ts`) and compared `sinceDeliveredMs >= dueMs` with **no tolerance**.
   `sinceDeliveredMs` is measured from the END of the previous delivery, but ticks fire ON the
   60 s boundary, so the due tick was always a few milliseconds short. For fronius, poll and push
   are both 60 s (`pushSec` is the only cadence it has), so every second tick was "poll-only".
3. **fusher's read is destructive.** `fusher.read()` calls `site.generateFroniusMinutely()`
   (`packages/usher/clients/fronius/site.ts`), which returns the energy accumulated since the last
   snapshot **and advances the snapshot**. A read that is not delivered discards that minute's Wh
   for good. Every second minute's energy was read and dropped, hence exactly half.
4. **Masked on 30 August.** #403 added `toleranceMs` (half a poll period) to `shouldDeliverTick` and
   the hub was redeployed. With 30 s of slack every fronius tick is delivered again, so the
   halving stopped, but the destructive read on a poll-only tick was still possible.

## The fix

- `Source.harvestOnDeliveryOnly` (`packages/usher/core/source.ts`), set by fusher. For such a
  source `tickOnce` decides delivery BEFORE reading and returns a poll-only result without touching
  the device (`readSkipped: true`). Every harvest is now a delivered harvest, whatever the cadence
  or the tolerance does.
- Test: `packages/usher/core/__tests__/run.test.ts` — "a harvesting source" drives `tickOnce` through
  the pre-#403 gate at a cadence that skips ticks, and asserts one read per delivery with every Wh
  delivered, plus a control run showing the loss without the flag.
- Detection: `liveone device coverage <device> --samples` reports each day's mean readings per
  5-minute row and flags a day under 80% of the window's best. Over 8 Aug–2 Sep it would have shown
  ~5 → ~2.5 on 11 August, the day it started.

## Data repair (prod)

Rebuild rids 43–48 for 11–30 August from Mondo's integrated power (device 6), which tracks Amber's
bill closely over the same period (the calibration goes in the session manifest):

1. Bound the window: `liveone device coverage 5 --start 2026-08-08 --end 2026-09-02 --samples`.
2. Pull Mondo 5-minute power (`device history 6 --interval 5m …`).
3. `scripts/utils/derive-fusher-wh-from-mondo.ts` turns it into `point,timestamp,value` Wh rows for
   the buckets whose stored `sample_count` is ≤ 3.
4. `liveone session create 5 …` with a manifest naming the source points, the method and the window.
5. `liveone import 5 --quality=estimated --session=<id> --overwrite-measured` (dry-run first).
6. `liveone device recompute 5 --start 2026-08-11 --end 2026-08-30 --apply`.
7. Verify daily grid import against Amber's E1 (within ~1–2%, like healthy days).

`estimated` is honest: the Sankey's "% estimated" chip will show for those days.

## Lessons

- **Don't deploy the hub from an unmerged branch.** Nothing reviewed what ran at Kinkora for three
  weeks. If a branch deploy is really needed, record it (branch, commit, date) and redeploy from
  `main` as soon as it merges.
- **A destructive read needs its own guard.** The poll/deliver split was designed for musher, where
  an undelivered read costs nothing. Any source whose `read()` consumes state has to say so, and
  now it can.
- **Row counts cannot see partial rows.** Coverage checks now have a samples-per-row view for that.
