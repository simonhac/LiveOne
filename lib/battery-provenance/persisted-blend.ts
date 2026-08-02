/**
 * Read the battery's per-interval blend back from the points the ENGINE already wrote.
 *
 * The fold (`computeBatteryProvenance`) is the only stateful thing in this subsystem: the battery's
 * contents at time T depend on every interval since the last reset, so a fold is only correct if it
 * was started far enough back. That is a property of the CALLER's window, which is why a read path
 * that re-folds is one forgotten lead-in away from being wrong — and why the EV run pricing was
 * (a cold fold priced a 100%-battery charge session at the grid tariff of the moment it started).
 *
 * There is no need for any read path to re-derive it. `writeBlendOutputs`
 * (lib/db/planetscale/battery-provenance-pg.ts) already persists the fold's per-interval output as
 * ordinary derived points on the `bidi.battery` stem, written by the minutely reconcile from a
 * checkpoint-seeded fold and re-written by the nightly heal. Reading them back is both cheaper than
 * folding and, by construction, the same number the Sankey's daily attribution used.
 *
 * 🛑 THE OFF-BY-ONE. `writeBlendOutputs` stamps the step for interval `i` at
 * `interval_end = timeline[i + 1]` (the interval's END), while `buildSourceIntensities` indexes the
 * same step at `i`. So the row to read for output slot `i` is the one at `timeline[i + 1]`, and the
 * result has `timeline.length - 1` entries — exactly what the fold returns. Indexing by
 * `timeline[i]` instead reads every interval one step early, which is a plausible-looking result
 * that is wrong by five minutes everywhere.
 */
import type { planetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import type { PointId } from "@/lib/ids";
import { boundPoints } from "./load";
import type { BatterySourceStep } from "./compute";

type PgDb = NonNullable<typeof planetscaleDb>;

const BATTERY_STEM = "bidi.battery";

/**
 * The blend metrics this reader needs, and how to undo `blendValue`'s write-side scaling
 * (lib/db/planetscale/battery-provenance-pg.ts): the two fractions are persisted as PERCENT, the
 * intensity and price in their natural units. `price-opportunity` and `stored-energy` are not read —
 * the load-path blend prices energy at its actual out-of-pocket cost, and the store's magnitude is
 * not an intensity.
 */
const BLEND_METRICS = {
  "carbon-intensity": { field: "batteryEmissionsIntensity", scale: 1 },
  "renewable-fraction": { field: "batteryRenewableFraction", scale: 0.01 },
  "self-renewable-fraction": {
    field: "batterySelfRenewableFraction",
    scale: 0.01,
  },
  price: { field: "batteryPrice", scale: 1 },
} as const satisfies Record<
  string,
  { field: keyof BatterySourceStep; scale: number }
>;

/**
 * Read purely as a PRESENCE marker, never as a factor.
 *
 * 🛑 It is the only way to tell "the engine has written nothing here" from "the battery was EMPTY",
 * and those must not be conflated. `blendValue` returns null for every intensity when the store is
 * empty — there is no blend to report — but writes `stored-energy` as a real 0. So an interval with
 * a `stored-energy` row and null intensities is a fully-computed interval that happens to have no
 * battery contents; a load running then is fed by grid and solar, and prices perfectly well off
 * those. Gating on "did any intensity resolve" instead reads a flat battery as a missing engine and
 * refuses to price the run at all — measured on prod, that would have dropped provenance from 5 real
 * EV sessions (14.4 kWh, $2.88) that `flow_attr_1d` prices without difficulty.
 */
const PRESENCE_METRIC = "stored-energy";

export interface PersistedBatteryBlend {
  /** One entry per interval — `timeline.length - 1` of them, index-aligned to the fold's own steps. */
  steps: BatterySourceStep[];
  /** Intervals that resolved a carbon intensity, i.e. the battery held something. */
  covered: number;
  /** Intervals the engine has actually written. 0 ⇒ nothing to read here — see {@link PRESENCE_METRIC}. */
  present: number;
}

/**
 * The battery's persisted blend over `timeline`, shaped as the `steps` `buildSourceIntensities` takes.
 *
 * Returns null when the Area has NO blend points bound at all — a different condition from a gap, and
 * one the caller must not paper over: with a `source.battery` in the flow series and no intensity for
 * it, every battery-fed interval would silently drop out of the blend and the run's cost would be
 * understated rather than absent. A per-interval MISS (a row the engine hasn't written yet) does
 * degrade that way on purpose: nulls flow through `blendLoadIntensities`'s unbiased-average rule, so
 * the interval is priced off the sources that ARE known instead of being diluted toward zero.
 */
export async function readPersistedBatteryBlend(
  db: PgDb,
  areaId: string,
  timeline: number[],
): Promise<PersistedBatteryBlend | null> {
  if (timeline.length < 2) return null;

  const bound = await boundPoints(db, areaId);
  const pointByMetric = new Map<string, PointId>();
  for (const b of bound) {
    if (b.stem !== BATTERY_STEM) continue;
    if (!(b.metric in BLEND_METRICS) && b.metric !== PRESENCE_METRIC) continue;
    // First binding wins, matching `boundPoints`' ordinal ordering — the same "first wins" the fold
    // uses to pick the battery device, so a second bound blend set cannot flip which one is read.
    if (!pointByMetric.has(b.metric)) pointByMetric.set(b.metric, b.point);
  }
  if (pointByMetric.size === 0) return null;

  const series = await ReadingsDao.read5m(
    [...pointByMetric.values()],
    // The rows are stamped at interval ENDS, so the span to fetch is (timeline[0], last] — the first
    // boundary is a start, never a row.
    { fromMs: timeline[0] + 1, toMs: timeline[timeline.length - 1] },
    db,
  );

  const steps: BatterySourceStep[] = Array.from(
    { length: timeline.length - 1 },
    () => ({
      batteryEmissionsIntensity: null,
      batteryRenewableFraction: null,
      batterySelfRenewableFraction: null,
      batteryPrice: null,
      estimatedFraction: 0,
    }),
  );

  // interval_end -> output index. Built from the timeline rather than by dividing by 5 minutes, so a
  // ragged timeline (a gap the loader resampled across) still lands each row on its own interval.
  const slotByEnd = new Map<number, number>();
  for (let i = 0; i < timeline.length - 1; i++)
    slotByEnd.set(timeline[i + 1], i);

  const presentSlots = new Set<number>();
  for (const [metric, point] of pointByMetric) {
    const spec = BLEND_METRICS[metric as keyof typeof BLEND_METRICS];
    for (const r of series.get(point) ?? []) {
      const slot = slotByEnd.get(r.intervalEndMs);
      if (slot === undefined) continue;
      if (r.avg !== null) presentSlots.add(slot);
      if (spec && r.avg !== null) steps[slot][spec.field] = r.avg * spec.scale;
      // `writeBlendOutputs` stamps the SAME data_quality on every blend point of a step, so any one
      // of them settles it; OR-ing is just insurance against a partially-rewritten interval.
      if (r.dataQuality === "estimated") steps[slot].estimatedFraction = 1;
    }
  }

  const covered = steps.reduce(
    (n, s) => n + (s.batteryEmissionsIntensity !== null ? 1 : 0),
    0,
  );
  return { steps, covered, present: presentSlots.size };
}
