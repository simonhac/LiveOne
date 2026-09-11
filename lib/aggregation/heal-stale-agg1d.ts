/**
 * The backstop for a daily aggregate that was computed from a store that had not finished landing.
 *
 * 🛑 **Why this has to exist even though the landing wait was fixed.** `agg_1d` is a pure function of
 * `agg_5m`, but nothing in the system recomputes a past day on its own: the observations receiver
 * rebuilds 5m only (1d is a deliberate no-op), `cron/daily` visits yesterday and never returns to it,
 * and coverage repair skips everything inside its grace window. So any day whose rebuild was wrong —
 * or never happened — stays wrong forever, and stays SELF-CONSISTENT while doing it. Kutis'
 * 2026-09-09 totals sat at solar 0 Wh and load 1,860 Wh against 5-minute rows summing to 35,330 and
 * 20,210 for two days, through two nightly runs, until someone compared the two by hand.
 *
 * The landing wait stops this run from writing a bad day. It cannot fix the days already written,
 * and it cannot help a run that timed out, crashed between the two writes, or was skipped precisely
 * BECAUSE the landing was incomplete — which is now the deliberate behaviour. A publisher-side fix
 * and a reader-side sweep answer different halves; only the sweep is self-healing.
 *
 * Keyed on "`agg_5m` newer than `agg_1d`", which is the shape
 * `docs/architecture/coverage-repair.md` proposed, and which needs no knowledge of what went wrong.
 * ⚠️ Rediscovery is bounded — by time, by budget, and by which devices a caller sweeps at all. Each
 * bound is a way a day is still lost permanently; `docs/plans/recompute-debt.md` is what closing
 * that would take, and why the case for it is the missing observable rather than the durability.
 * It is race-free (it reads only committed state, long after any delivery) and self-terminating (a
 * rebuild sets `agg_1d.updated_at` to now, so a healed day stops matching).
 */
import type { planetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import { PointManager } from "@/lib/point/point-manager";
import { Point } from "@/lib/ids";
import {
  recomputeDerivedForDeviceDays,
  type ScopedRecomputeDevice,
} from "@/lib/aggregation/scoped-recompute";

type PgDb = NonNullable<typeof planetscaleDb>;

/**
 * Days to rebuild in one run, per device.
 *
 * A cap rather than a budget: a device with a long tail of stale days drains it over successive
 * nights instead of spending one run's whole `maxDuration` on history, which is the failure
 * `aggregateRange` used to produce. The days are sorted, so it always works oldest-first and makes
 * monotonic progress rather than re-picking the same slice.
 */
const MAX_DAYS_PER_DEVICE = 14;

/** Days rebuilt between deadline checks — small enough to stop promptly, large enough to amortise. */
const HEAL_BATCH_DAYS = 3;

export interface HealResult {
  /** Local days found stale, before the cap. */
  found: string[];
  /** Local days actually rebuilt this run. */
  healed: string[];
  agg1dDays: number;
  provenanceAreas: number;
}

/**
 * Find and rebuild this device's stale local days within `lookbackDays`.
 *
 * ⚠️ **Excludes the current local day, and must.** The live poll keeps writing 5m rows all day, so
 * today's `agg_5m` is essentially always newer than whatever `agg_1d` it has — today would match on
 * every run forever. Today is also the one day nothing needs healing for: `cron/daily` rebuilds it
 * as yesterday tomorrow.
 *
 * Never throws: this is a backstop running ahead of the caller's real work, and it must not be the
 * reason a backfill does not happen.
 */
export async function healStaleAgg1dForDevice(
  db: PgDb,
  device: ScopedRecomputeDevice,
  opts: {
    lookbackDays: number;
    nowMs?: number;
    label?: string;
    /**
     * Wall-clock deadline, checked BETWEEN batches of days.
     *
     * A caller-level "is there time left" check before entering this function does not bound it: one
     * device can rebuild `MAX_DAYS_PER_DEVICE` days plus Area provenance for each, so a device
     * entered a second before the budget expires can still consume the rest of the invocation and
     * leave no time for the work the caller actually exists to do.
     */
    deadlineMs?: number;
    /** Injectable clock, so the deadline behaviour is testable without real time. */
    now?: () => number;
  },
): Promise<HealResult> {
  const empty: HealResult = {
    found: [],
    healed: [],
    agg1dDays: 0,
    provenanceAreas: 0,
  };
  const nowMs = opts.nowMs ?? Date.now();
  const label = opts.label ?? "HealStale";

  try {
    const map = await PointManager.getInstance().loadPointInfoMap(device.id);
    const points = Object.values(map).map((p) => Point.encode(p.pointUid));
    if (points.length === 0) return empty;

    // The local day currently in progress, in the device's own offset — the exclusive upper bound.
    const offsetMs = device.timezoneOffsetMin * 60_000;
    const todayStartLocalMs =
      Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;

    const found = await ReadingsDao.staleAgg1dLocalDays(
      points,
      {
        fromMs: todayStartLocalMs - opts.lookbackDays * 86_400_000,
        toMs: todayStartLocalMs,
        offsetMin: device.timezoneOffsetMin,
      },
      db,
    );
    if (found.length === 0) return empty;

    const planned = found.slice(0, MAX_DAYS_PER_DEVICE);
    console.log(
      `[${label}] system ${device.id}: ${found.length} stale day(s) ` +
        `(agg_5m newer than agg_1d); rebuilding ${planned.length}: ${planned.join(", ")}`,
    );
    const healed: string[] = [];
    let agg1dDays = 0;
    let provenanceAreas = 0;
    for (let i = 0; i < planned.length; i += HEAL_BATCH_DAYS) {
      if (
        opts.deadlineMs != null &&
        (opts.now ?? Date.now)() >= opts.deadlineMs
      ) {
        console.warn(
          `[${label}] system ${device.id}: stale sweep out of budget after ` +
            `${healed.length}/${planned.length} day(s); the rest roll to the next run`,
        );
        break;
      }
      const batch = planned.slice(i, i + HEAL_BATCH_DAYS);
      const r = await recomputeDerivedForDeviceDays(
        db,
        device,
        batch,
        nowMs,
        label,
      );
      healed.push(...batch);
      agg1dDays += r.agg1dDays;
      provenanceAreas += r.provenanceAreas;
    }
    return { found, healed, agg1dDays, provenanceAreas };
  } catch (err) {
    console.error(`[${label}] system ${device.id}: stale sweep failed:`, err);
    return empty;
  }
}
