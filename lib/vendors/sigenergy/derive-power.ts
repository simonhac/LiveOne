/**
 * Sigenergy POWER + SoC gap recovery.
 *
 * Sigenergy is the one vendor whose two halves come from different places: interval ENERGY from the
 * statistics endpoint (`statistics.ts`, re-fetchable for any past day) and instantaneous POWER + SoC
 * from the live energy-flow snapshot (`adapter.ts`), one sample per 5-minute slot with no
 * redundancy and NO historical endpoint to re-ask. So a slot the poller misses is a permanent hole
 * in every power series and in SoC, while the energy for that same slot is complete.
 *
 * Measured on prod for Kutis, 2026-08-01..30: all six `*_interval_wh` points 0/8640 missing; every
 * power series and `bidi.battery/soc.last` 70/8640 missing — the SAME intervals for every point,
 * because it is the whole poll that is lost. On the chart those become breaks
 * (`d3.line().defined()`), which is what this module exists to close.
 *
 * ## The vendor's own power comes first
 *
 * The `statistics/energy` `itemList` also carries the INSTANTANEOUS power and SoC for each
 * historical interval (`pvTotalPower`, `loadPower`, `toGridPower`, `fromGridPower`,
 * `esChargePower`, `esDischargePower`, `batSoc`) — the same snapshot fields the live endpoint
 * returns. Where those are present they are used verbatim, because they are a MEASUREMENT of the
 * interval, not a reconstruction of it: exact rather than quantised to 0.01 kWh, subject to no
 * interpolation cap, and independent of the counters (at the 2026-08-20 19:20 dropout every energy
 * counter collapsed while `loadPower` and `batSoc` stayed sane). Validated against our own polled
 * samples for that day, n=268: `pvTotalPower` matches to a median 0.0 W, `batSoc` to 0.0 %.
 *
 * They are written with `data_quality` "good" and NOT one of the derived markers. That is the
 * honest label — the value is the vendor's record of that interval, the same thing the poll would
 * have captured had it run — and it keeps them out of the "% estimated" accounting, which is about
 * confidence, not provenance. Which rows arrived this way is answerable from `session_id`; using a
 * quality marker to carry provenance is the mistake Amber's abbreviation already made.
 *
 * Everything below is the FALLBACK, for an interval whose power fields are absent.
 *
 * ## What can be recovered, and how honestly
 *
 * `calculated` — exact, by identity, from the interval energy of the SAME interval (Wh x 12 = mean
 * W over 5 minutes). Signs are canonical "inflow positive", matching `sigenergyFlowToData`:
 *
 *   source.solar        = solar
 *   bidi.grid   (+ import)  = import - export
 *   bidi.battery(+ discharge) = discharge - charge
 *   TOTAL load          = powerUse
 *
 * `interpolated` — linear between the bracketing MEASURED samples, and only across short holes:
 *
 *   load.ev             — EV power is near-constant within a charge session
 *   load.rest-of-house  = total load - interpolated EV
 *   bidi.battery/soc    — SoC moves smoothly at this timescale
 *
 * The EV/rest-of-house split has to be interpolated because the energy counters cannot separate
 * them. Verified against prod 2026-08-20: on intervals where the EV draws >2 kW (n=20), the median
 * |powerUse x 12 - rest-of-house| is 7060 W against 290 W for |powerUse x 12 - (rest-of-house +
 * ev)| — i.e. `powerUse` is TOTAL household load, EV included. The vendor's balance identity
 * (`solar + grid + battery - rest-of-house = ev`, residual 0.0 W at p90 AND max over n=268) is pure
 * conservation, so it is already implied by total load and adds no information to the split.
 *
 * Beyond `MAX_INTERP_INTERVALS`, and wherever a hole is not bracketed by measured samples on both
 * sides, nothing is written. A long outage is honestly unknown and a broken line is the correct
 * rendering; extrapolating off the end of a run would be inventing data, not recovering it.
 *
 * ## Accuracy
 *
 * ## Counter dropouts
 *
 * The vendor's cumulative counters occasionally read ~0 for a single sample, which makes the
 * differenced interval energy show a large NEGATIVE delta immediately cancelled by an equal
 * positive one. Observed twice on 2026-08-20 alone, across all six counters at once:
 *
 *     19:15   solar     0 Wh    (measured power 0 W)
 *     19:20   solar -26970 Wh   (measured power 0 W)   <- counter dropped out
 *     19:25   solar +26970 Wh   (measured power 0 W)   <- and came back
 *     19:30   solar     0 Wh
 *
 * `computeDayEnergyReadings` keeps those diffs SIGNED on purpose, because the pair telescopes and
 * the day still reconciles to the vendor's headline total (clamping the negatives would inflate it
 * — grid import came out 37x high when that was tried). Correct for a total; useless for a single
 * interval, where x12 would paint a 324 kW spike on the chart.
 *
 * The freeze can also last SEVERAL intervals, so the rebound is not necessarily adjacent to the
 * negative — which is why the guard tracks an unrepaid DEFICIT per counter rather than just looking
 * at the previous interval. A negative delta opens a deficit; every interval is distrusted until
 * subsequent deltas have repaid it. No thresholds, because the deltas telescope: the deficit is
 * exactly the energy the counter owes.
 *
 * The one exception is a single-ULP negative. The counters are rounded to 0.01 kWh, so a low-volume
 * metric flickers (...0 -> 0.01 -> 0 -> 0.01...); treating that as a dropout distrusted HALF of all
 * grid intervals for what is only rounding noise. Negatives within one ULP are read as zero.
 *
 * Measured over 2026-08-01..30 (8640 intervals), worst |derived - measured|:
 *
 *     metric    no guard    deficit-tracking    intervals kept
 *     solar      323.6 kW        5.6 kW              98%
 *     grid        33.2 kW        5.5 kW              99%
 *     battery    203.9 kW        6.4 kW              98%
 *
 * What survives is ordinary mean-vs-instantaneous disagreement (p90 is 260-540 W), not glitches.
 * A dropout that straddles local midnight is not caught — the deficit starts at zero each day,
 * because a day is fetched and differenced on its own.
 *
 * The counters are rounded to 0.01 kWh, so a derived power carries +/-120 W of quantisation.
 * Separately, the MEASURED `power.avg` is a single instantaneous snapshot (`sample_count = 1`), not
 * a mean, so it and the derived value legitimately disagree in fast-changing intervals (median
 * relative 17% solar / 18% battery / 38% grid on 2026-08-20). The derived figure is the more honest
 * 5-minute average of the two; neither is wrong.
 *
 * Derived rows are written through the ordinary `insertPointReadingsAgg5m` path and therefore get
 * `avg = min = max = last = value, sample_count = 1`, exactly like a measured Sigenergy row (which
 * also has a single sample, so its min/max carry no more information). `data_quality` is the ONLY
 * thing that distinguishes them, which is the whole design — see `lib/data-quality.ts`.
 */

import { PointManager, type PointMetadata } from "@/lib/point/point-manager";
import { ReadingsDao } from "@/lib/readings";
import { Point } from "@/lib/ids";
import { trustedByDeficit } from "@/lib/aggregation/counter-deficit";
import { SIGENERGY_POINTS } from "./point-metadata";

const FIVE_MIN_MS = 5 * 60 * 1000;

/** Wh over a 5-minute interval -> mean W. */
const WH_TO_W = 60 / 5;

/**
 * Longest hole that may be interpolated, in 5-minute intervals.
 *
 * 3 (15 minutes) is deliberately short. Prod holes are overwhelmingly ONE interval wide — the
 * cadence report's `gap max` for Kutis over 48 h was exactly 10 min, i.e. a single skipped slot —
 * so a small cap recovers essentially all of them while refusing to paint over a real outage, where
 * a straight line between two distant samples would be fiction. `forwardFill`'s `maxStaleMs`
 * (`lib/battery-provenance/load.ts`) bounds its fill for the same reason.
 */
export const MAX_INTERP_INTERVALS = 3;

/** The six energy counters for one 5-minute interval, in Wh. `null` = not reported. */
export interface IntervalEnergyWh {
  solar: number | null;
  /** TOTAL household load — INCLUDES the EV. See the header. */
  load: number | null;
  gridImport: number | null;
  gridExport: number | null;
  batteryCharge: number | null;
  batteryDischarge: number | null;
}

/** An existing measured 5m row, used as an interpolation anchor. */
export interface MeasuredSample {
  intervalEndMs: number;
  value: number;
}

/**
 * The vendor's instantaneous sample for one interval, in LiveOne's canonical units and signs
 * (Watts, inflow-positive) — already normalised, so this module never sees the vendor convention.
 */
export interface VendorPowerSample {
  solarW: number | null;
  /** TOTAL site load, EV included — there is no EV field. */
  loadW: number | null;
  /** + import. */
  gridW: number | null;
  /** + discharge. */
  batteryW: number | null;
  socPct: number | null;
}

export interface DerivedReading {
  pointMetadata: PointMetadata;
  rawValue: number;
  intervalEndMs: number;
  /** "good" = the vendor's own recorded sample; the others are ours. See the header. */
  dataQuality: "good" | "calculated" | "interpolated";
}

const metadataByTail = new Map<string, PointMetadata>(
  SIGENERGY_POINTS.map((p) => [p.metadata.physicalPathTail, p.metadata]),
);

/** The point tails this module can write. Exported so the coverage provider stays in step. */
export const SIGEN_DERIVED_TAILS = [
  "solar_w",
  "grid_w",
  "battery_w",
  "load_w",
  "ev_w",
  "battery_soc",
] as const;

export type SigenDerivedTail = (typeof SIGEN_DERIVED_TAILS)[number];

function meta(tail: SigenDerivedTail): PointMetadata {
  const m = metadataByTail.get(tail);
  if (!m) throw new Error(`No Sigenergy point metadata for tail '${tail}'`);
  return m;
}

/**
 * Linear interpolation across a hole, from the measured samples bracketing it.
 *
 * `samples` must be ascending by `intervalEndMs`. Returns null when the interval is not bracketed
 * on BOTH sides, or when the bracketing samples are further apart than `maxSpanMs` — no
 * extrapolation, and no straight line drawn across an outage.
 */
export function interpolateAt(
  samples: MeasuredSample[],
  intervalEndMs: number,
  maxSpanMs: number,
): number | null {
  if (samples.length < 2) return null;
  // Nearest measured sample strictly before, and strictly after.
  let lo: MeasuredSample | null = null;
  let hi: MeasuredSample | null = null;
  for (const s of samples) {
    if (s.intervalEndMs < intervalEndMs) lo = s;
    else if (s.intervalEndMs > intervalEndMs) {
      hi = s;
      break;
    } else return s.value; // already measured — caller should not have asked
  }
  if (!lo || !hi) return null;
  const span = hi.intervalEndMs - lo.intervalEndMs;
  if (span <= 0 || span > maxSpanMs) return null;
  const t = (intervalEndMs - lo.intervalEndMs) / span;
  return lo.value + (hi.value - lo.value) * t;
}

/**
 * One ULP of the vendor's cumulative counters: they are reported to 0.01 kWh.
 *
 * A negative delta this small is rounding flicker on a low-volume metric, not a dropout. Treating
 * it as one distrusted 49% of grid intervals for no accuracy gain.
 */
export const COUNTER_ULP_WH = 10;

const ENERGY_FIELDS: readonly (keyof IntervalEnergyWh)[] = [
  "solar",
  "load",
  "gridImport",
  "gridExport",
  "batteryCharge",
  "batteryDischarge",
];

/**
 * Per interval, which counters can be read as that interval's own energy.
 *
 * A counter that goes backwards has dropped out and now owes the difference; every interval is
 * distrusted until the debt is repaid, because the repaying interval carries several intervals'
 * energy in one bucket. See the header for the measurements behind this.
 *
 * `ordered` must be ascending by interval end.
 */
export function trustedCounters(
  ordered: readonly (readonly [number, IntervalEnergyWh])[],
): Map<number, Set<keyof IntervalEnergyWh>> {
  // One deficit scan per counter. The scan itself is shared with the flow-matrix energy overlay
  // (`lib/aggregation/counter-deficit.ts`) — same defect, same data, and two guards that disagreed
  // about it is how the overlay kept a bug this one had already fixed.
  const perField = new Map<keyof IntervalEnergyWh, boolean[]>();
  for (const field of ENERGY_FIELDS) {
    perField.set(
      field,
      trustedByDeficit(
        ordered.map(([, e]) => e[field]),
        COUNTER_ULP_WH,
      ),
    );
  }

  const out = new Map<number, Set<keyof IntervalEnergyWh>>();
  ordered.forEach(([ms], i) => {
    const ok = new Set<keyof IntervalEnergyWh>();
    for (const field of ENERGY_FIELDS) {
      if (perField.get(field)![i]) ok.add(field);
    }
    out.set(ms, ok);
  });
  return out;
}

/**
 * Build the fill readings for one day. PURE — no I/O, so the arithmetic and the refusals are
 * unit-testable.
 *
 * `presentByTail` is what the serving store ALREADY has: a derived row is emitted only for an
 * interval absent from its point's set, so a measured value can never be overwritten. (The write
 * path upserts at the receiver, so this filter — not the DAO's conflict clause — is what protects
 * measured data. See `deriveDayPowerReadings`'s caller for the settle margin that closes the
 * read-then-write race.)
 */
export function computeDerivedPowerReadings(params: {
  /** Interval energy keyed by `interval_end` epoch-ms, for one local day. */
  energyByIntervalEnd: Map<number, IntervalEnergyWh>;
  /** Per-tail sets of interval ends that already have a row. */
  presentByTail: Map<string, Set<number>>;
  /** Existing measured `load.ev` power samples, ascending — anchors for the EV split. */
  measuredEv: MeasuredSample[];
  /** Existing measured `bidi.battery/soc` samples, ascending. */
  measuredSoc: MeasuredSample[];
  /** The vendor's own per-interval samples, keyed by `interval_end` epoch-ms. Preferred over
   *  anything derived — see the header. */
  vendorPower?: Map<number, VendorPowerSample>;
  /**
   * The tails this device actually HAS. Required: a tail missing from `presentByTail` is otherwise
   * indistinguishable from one with no rows yet, and emitting a reading for a point that does not
   * exist would MINT it (`ensurePointInfo`) — inventing an `ev_w` point on a site with no charger.
   */
  availableTails: ReadonlySet<string>;
  maxInterpIntervals?: number;
}): DerivedReading[] {
  const {
    energyByIntervalEnd,
    presentByTail,
    measuredEv,
    measuredSoc,
    availableTails,
    vendorPower,
    maxInterpIntervals = MAX_INTERP_INTERVALS,
  } = params;

  // A hole of N intervals has its anchors N+1 intervals apart.
  const maxSpanMs = (maxInterpIntervals + 1) * FIVE_MIN_MS;
  const out: DerivedReading[] = [];

  const isMissing = (tail: SigenDerivedTail, ms: number) =>
    availableTails.has(tail) && !presentByTail.get(tail)?.has(ms);

  const push = (
    tail: SigenDerivedTail,
    ms: number,
    value: number,
    dataQuality: DerivedReading["dataQuality"],
  ) => {
    out.push({
      pointMetadata: meta(tail),
      // Watts, to the same integer resolution the live adapter stores (`toW` rounds).
      rawValue: Math.round(value) + 0, // `+ 0` avoids -0
      intervalEndMs: ms,
      dataQuality,
    });
  };

  // SoC needs only its own bracketing samples — the energy counters say nothing about it. The loop
  // below is keyed on the energy intervals because in practice they are complete (0/8640 missing on
  // prod) while the power ones are not; an interval the statistics endpoint never reported gets no
  // SoC fill either, which is the conservative side to err on.
  const socPresent = presentByTail.get("battery_soc") ?? new Set<number>();

  const ordered = [...energyByIntervalEnd].sort((a, b) => a[0] - b[0]);
  const trusted = trustedCounters(ordered);

  for (const [ms, e] of ordered) {
    const trust = trusted.get(ms)!;
    /** Is this counter's delta usable as a 5-minute energy in its own right? See the header. */
    const usable = (field: keyof IntervalEnergyWh): boolean =>
      e[field] != null && trust.has(field);

    const vp = vendorPower?.get(ms);

    // --- the vendor's own sample, where it has one ------------------------------------------------
    // A measurement of the interval, so it is preferred over every reconstruction below and carries
    // no derived marker. Each field is taken on its own: a payload missing one still contributes the
    // others, and whatever it lacks falls through to the counter arithmetic.
    if (vp?.solarW != null && isMissing("solar_w", ms)) {
      push("solar_w", ms, vp.solarW, "good");
    }
    if (vp?.gridW != null && isMissing("grid_w", ms)) {
      push("grid_w", ms, vp.gridW, "good");
    }
    if (vp?.batteryW != null && isMissing("battery_w", ms)) {
      push("battery_w", ms, vp.batteryW, "good");
    }
    if (vp?.socPct != null && isMissing("battery_soc", ms)) {
      out.push({
        pointMetadata: meta("battery_soc"),
        rawValue: vp.socPct,
        intervalEndMs: ms,
        dataQuality: "good",
      });
    }

    // --- fallback: calculated, straight from the counters ----------------------------------------
    if (vp?.solarW == null && usable("solar") && isMissing("solar_w", ms)) {
      push("solar_w", ms, e.solar! * WH_TO_W, "calculated");
    }
    if (
      vp?.gridW == null &&
      usable("gridImport") &&
      usable("gridExport") &&
      isMissing("grid_w", ms)
    ) {
      push(
        "grid_w",
        ms,
        (e.gridImport! - e.gridExport!) * WH_TO_W,
        "calculated",
      );
    }
    if (
      vp?.batteryW == null &&
      usable("batteryCharge") &&
      usable("batteryDischarge") &&
      isMissing("battery_w", ms)
    ) {
      push(
        "battery_w",
        ms,
        (e.batteryDischarge! - e.batteryCharge!) * WH_TO_W,
        "calculated",
      );
    }

    // --- the EV / rest-of-house split -------------------------------------------------------------
    // Total load is exact; only the split is inferred, so the uncertainty is confined to it and the
    // two always sum back to the measured total.
    // Total load is exact from either source; only its EV / rest-of-house split is ever inferred, so
    // the marker below stays `interpolated` even when the total came from the vendor.
    const totalFromVendor = vp?.loadW ?? null;
    const totalW =
      totalFromVendor ?? (usable("load") ? e.load! * WH_TO_W : null);
    if (totalW != null && (isMissing("ev_w", ms) || isMissing("load_w", ms))) {
      if (!availableTails.has("ev_w")) {
        // No charger on this site, so there is nothing to split off: total load IS rest-of-house,
        // and that is a calculation, not an inference.
        if (isMissing("load_w", ms)) push("load_w", ms, totalW, "calculated");
      } else {
        const evW = interpolateAt(measuredEv, ms, maxSpanMs);
        if (evW != null) {
          // EV power is a load: never negative, and never more than the whole house drew.
          const ev = Math.min(Math.max(evW, 0), Math.max(totalW, 0));
          if (isMissing("ev_w", ms)) push("ev_w", ms, ev, "interpolated");
          if (isMissing("load_w", ms))
            push("load_w", ms, totalW - ev, "interpolated");
        }
      }
    }

    // --- interpolated: SoC ------------------------------------------------------------------------
    if (
      vp?.socPct == null &&
      availableTails.has("battery_soc") &&
      !socPresent.has(ms)
    ) {
      const soc = interpolateAt(measuredSoc, ms, maxSpanMs);
      if (soc != null) {
        out.push({
          pointMetadata: meta("battery_soc"),
          // SoC is a percentage; the live adapter stores it unrounded, so keep a decimal.
          rawValue: Math.round(Math.min(Math.max(soc, 0), 100) * 10) / 10,
          intervalEndMs: ms,
          dataQuality: "interpolated",
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// I/O half: read what the serving store already has, then hand the pure core above the difference.
// ---------------------------------------------------------------------------------------------

/** Which counter each energy point's tail carries. */
const ENERGY_TAIL_TO_FIELD: Record<string, keyof IntervalEnergyWh> = {
  solar_interval_wh: "solar",
  load_interval_wh: "load",
  grid_import_interval_wh: "gridImport",
  grid_export_interval_wh: "gridExport",
  battery_charge_interval_wh: "batteryCharge",
  battery_discharge_interval_wh: "batteryDischarge",
};

const emptyInterval = (): IntervalEnergyWh => ({
  solar: null,
  load: null,
  gridImport: null,
  gridExport: null,
  batteryCharge: null,
  batteryDischarge: null,
});

/**
 * Regroup the flat per-point energy readings into one tuple per interval.
 *
 * Typed structurally, not against `statistics.ts`'s `Agg5mReading`, so the energy collector can
 * import this module without the two importing each other.
 */
export function energyReadingsToIntervals(
  readings: readonly {
    pointMetadata: { physicalPathTail: string };
    rawValue: number;
    intervalEndMs: number;
  }[],
): Map<number, IntervalEnergyWh> {
  const out = new Map<number, IntervalEnergyWh>();
  for (const r of readings) {
    const field = ENERGY_TAIL_TO_FIELD[r.pointMetadata.physicalPathTail];
    if (!field) continue;
    let slot = out.get(r.intervalEndMs);
    if (!slot) {
      slot = emptyInterval();
      out.set(r.intervalEndMs, slot);
    }
    // The collector emits at most one reading per (point, interval); a duplicate would mean the
    // day was double-differenced, so take the first and let the later one be ignored rather than
    // silently summing two views of the same interval.
    if (slot[field] == null) slot[field] = r.rawValue;
  }
  return out;
}

/**
 * How close to `now` an interval may be and still be filled.
 *
 * The derived rows travel the ordinary queue -> receiver path, which UPSERTS, so "don't overwrite a
 * measurement" is enforced by only emitting rows for intervals that had none when we read. That
 * read-then-write window is the one place a late-landing measurement could be overwritten — a
 * QStash retry still in flight, say. QStash retries over minutes, so half an hour of clearance
 * closes it without costing anything: the backfill runs at 00:20 station-local over whole past
 * days, so nothing it targets is anywhere near this boundary in normal operation.
 */
export const DERIVE_SETTLE_MS = 30 * 60 * 1000;

/**
 * Build the day's fill readings, reading current coverage from the serving store.
 *
 * Returns `[]` — never throws — when the device has no power points, when the day is entirely
 * covered, or when the store cannot be read. Recovery is a bonus pass over a backfill that has
 * already done its real work; it must not be able to fail that backfill.
 */
export async function deriveDayPowerReadings(params: {
  systemId: number;
  /** The energy readings just computed for this day (`computeDayEnergyReadings`). */
  energyReadings: readonly {
    pointMetadata: { physicalPathTail: string };
    rawValue: number;
    intervalEndMs: number;
  }[];
  /** The vendor's own per-interval samples, keyed by `interval_end` epoch-ms. */
  vendorPower?: Map<number, VendorPowerSample>;
  nowMs?: number;
  settleMs?: number;
  maxInterpIntervals?: number;
}): Promise<DerivedReading[]> {
  const nowMs = params.nowMs ?? Date.now();
  const settleMs = params.settleMs ?? DERIVE_SETTLE_MS;

  const energyByIntervalEnd = energyReadingsToIntervals(params.energyReadings);
  // Anything too close to now is left for the live path to fill properly.
  for (const ms of [...energyByIntervalEnd.keys()]) {
    if (ms > nowMs - settleMs) energyByIntervalEnd.delete(ms);
  }
  if (energyByIntervalEnd.size === 0) return [];

  const pointMap = await PointManager.getInstance().loadPointInfoMap(
    params.systemId,
  );
  const targets = SIGEN_DERIVED_TAILS.map((tail) => ({
    tail,
    row: pointMap[tail],
  })).filter((x) => x.row != null);
  if (targets.length === 0) return [];

  // Widen the read past the day's edges so a hole at midnight can still find anchors on both
  // sides — interpolation refuses to extrapolate, so without this every day boundary is a gap.
  const ends = [...energyByIntervalEnd.keys()];
  const pad = (params.maxInterpIntervals ?? MAX_INTERP_INTERVALS) * FIVE_MIN_MS;
  const window = {
    fromMs: Math.min(...ends) - pad - FIVE_MIN_MS,
    toMs: Math.max(...ends) + pad + FIVE_MIN_MS,
    toInclusive: true,
  };

  const series = await ReadingsDao.read5m(
    targets.map((x) => Point.encode(x.row!.pointUid)),
    window,
  );

  const presentByTail = new Map<string, Set<number>>();
  const measuredEv: MeasuredSample[] = [];
  const measuredSoc: MeasuredSample[] = [];

  for (const { tail, row } of targets) {
    const rows = series.get(Point.encode(row!.pointUid)) ?? [];
    presentByTail.set(tail, new Set(rows.map((r) => r.intervalEndMs)));
    if (tail !== "ev_w" && tail !== "battery_soc") continue;
    for (const r of rows) {
      // Anchor only on MEASURED samples. Interpolating from an earlier interpolation would let a
      // fill propagate across a hole far longer than the cap allows, one run at a time.
      if (r.dataQuality != null && r.dataQuality !== "good") continue;
      const v = r.avg ?? r.last;
      if (v == null) continue;
      (tail === "ev_w" ? measuredEv : measuredSoc).push({
        intervalEndMs: r.intervalEndMs,
        value: v,
      });
    }
  }
  measuredEv.sort((a, b) => a.intervalEndMs - b.intervalEndMs);
  measuredSoc.sort((a, b) => a.intervalEndMs - b.intervalEndMs);

  return computeDerivedPowerReadings({
    energyByIntervalEnd,
    presentByTail,
    measuredEv,
    measuredSoc,
    availableTails: new Set(targets.map((x) => x.tail)),
    vendorPower: params.vendorPower,
    maxInterpIntervals: params.maxInterpIntervals,
  });
}
