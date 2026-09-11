/**
 * Reconstructing Daylesford's 5-minute series from the SP PRO's own 15-minute detailed log.
 *
 * Unlike the Mondo archive, this is NOT a column mapping. The inverter's log and LiveOne's points
 * do not measure the same things, and two steps stand between them.
 *
 * ## 1. What each LiveOne series actually is
 *
 * Established by regressing SP LINK against LiveOne over August 2026 (n = 2 968; each 15-minute
 * record against the mean of its three 5-minute buckets), on a window where both hold data:
 *
 *   bidi.battery/soc        = state_of_charge_percent                       r = 1.00000
 *   source.solar.remote     = ac_coupled_power_average_kw x 1000            r = 0.9887  slope 1.005
 *   source.solar.local      = -shunt1_current_average_a x dc_voltage_avg_v  r = 0.9843  slope 1.007
 *   source.solar            = remote + local                               r = 0.9886  slope 1.005
 *   load                    = load_ac_power_average_kw x 1000               r = 0.9825  slope 0.998
 *   bidi.battery/power      = load - solar_total                            r = 0.9845  slope 1.018
 *   bidi.grid/power         = ac_input_power_average_kw x 1000              (identically 0; off-grid)
 *
 * 🛑 **Battery power is an IDENTITY, not a column.** The obvious candidate,
 * `inverter_ac_power_average_kw`, correlates at -0.970 with slope -1.302 — wrong sign and an
 * unexplained 1.3x. The explanation is that LiveOne's `1/bidi.battery/power` is not an independent
 * measurement either: against LiveOne's OWN series it is `load - solar_total` at r = 0.99292. The
 * 1.3 was `ac_coupled_power_average_kw` carrying only the REMOTE half of solar. Fitting a constant
 * to make the wrong column agree would have produced a plausible battery trace that is not the
 * battery; there are no fitted constants here.
 *
 * 🛑 **`shunt2` is identically zero at this site and `shunt1` carries the DC-coupled solar, sign
 * inverted.** That is a wiring fact about this inverter, not a property of the SP PRO.
 *
 * ## 2. Fifteen minutes into five
 *
 * The averages are averages over `(T-15, T]` — the trailing window fits at r = 0.9825 against
 * 0.9648 leading. So one record feeds the three 5-minute buckets STARTING at T-15, T-10 and T-5.
 *
 * A step hold would preserve each window's energy exactly and render as a staircase. Instead the
 * values are interpolated linearly between consecutive windows' CENTRES and then RESCALED so each
 * triple's mean is exactly the recorded 15-minute average. That is smooth AND interval-energy
 * preserving — the daily totals `recomputeAgg1dForDay` builds are unaffected by the smoothing.
 *
 * SoC is different: it is an instantaneous value at T, not an average, so it is the LAST sample of
 * the bucket ENDING at T and is interpolated linearly between stamps. Two intervening buckets,
 * inside `derive-power.ts`'s `MAX_INTERP_INTERVALS = 3`. See `resampleInstant` — the off-by-one
 * here is invisible downstream.
 *
 * 🛑 **No extrapolation.** A window with no neighbour on the side the interpolation needs falls
 * back to the step hold rather than continuing a trend off the end of the run — `derive-power.ts`:
 * "a long outage is honestly unknown and a broken line is the correct rendering". A window whose
 * neighbour is more than one interval away (the eight isolated missing records the archive
 * declares) is treated the same way.
 *
 * Everything here is `estimated`: the values are a model of what the 5-minute series would have
 * read, not the vendor's record of it. `derive-power.ts` reserves `calculated` for an exact
 * identity within one interval; the resample is what makes these inexact.
 */

export const FIFTEEN_MIN_MS = 15 * 60 * 1000;
export const FIVE_MIN_MS = 5 * 60 * 1000;

/** The SP LINK columns this reconstruction reads. */
export interface SplinkRecord {
  /** Epoch ms of the record stamp — the END of the window its averages cover. */
  tMs: number;
  loadAcKw: number | null;
  acCoupledKw: number | null;
  shunt1A: number | null;
  dcVoltageV: number | null;
  acInputKw: number | null;
  socPct: number | null;
}

/** The LiveOne series this produces, by logical path. */
export type Series =
  | "load/power"
  | "source.solar.remote/power"
  | "source.solar.local/power"
  | "source.solar/power"
  | "bidi.battery/power"
  | "bidi.grid/power"
  | "bidi.battery/soc";

/** The AVERAGED series — one 15-minute figure spread over three buckets. */
export const AVERAGED: Series[] = [
  "load/power",
  "source.solar.remote/power",
  "source.solar.local/power",
  "source.solar/power",
  "bidi.battery/power",
  "bidi.grid/power",
];

/**
 * The seven quantities one record implies, in LiveOne's units and sign conventions.
 * Null where an input the identity needs is missing — never a zero standing in for absence.
 */
export function quantities(r: SplinkRecord): Record<Series, number | null> {
  const w = (kw: number | null) => (kw === null ? null : kw * 1000);
  const load = w(r.loadAcKw);
  const remote = w(r.acCoupledKw);
  const local =
    r.shunt1A === null || r.dcVoltageV === null
      ? null
      : -r.shunt1A * r.dcVoltageV;
  const solar = remote === null || local === null ? null : remote + local;
  const battery = load === null || solar === null ? null : load - solar;
  return {
    "load/power": load,
    "source.solar.remote/power": remote,
    "source.solar.local/power": local,
    "source.solar/power": solar,
    "bidi.battery/power": battery,
    "bidi.grid/power": w(r.acInputKw),
    "bidi.battery/soc": r.socPct,
  };
}

export interface Resampled {
  /** Interval START, epoch ms. */
  startMs: number;
  value: number;
  /** True when the triple was held flat because a neighbour was missing. */
  held: boolean;
}

/**
 * Spread one series of 15-minute AVERAGES across 5-minute buckets, preserving each window's mean.
 *
 * `byT` must be sorted ascending. Windows whose value is null produce nothing at all.
 */
export function resampleAverages(
  byT: Array<{ tMs: number; value: number | null }>,
): Resampled[] {
  const known = new Map(
    byT.filter((r) => r.value !== null).map((r) => [r.tMs, r.value!]),
  );
  const out: Resampled[] = [];

  for (const { tMs, value } of byT) {
    if (value === null) continue;
    // The window's own centre, and its neighbours' — one interval either side, never further.
    const prev = known.get(tMs - FIFTEEN_MIN_MS) ?? null;
    const next = known.get(tMs + FIFTEEN_MIN_MS) ?? null;

    // Bucket centres sit at -12.5, -7.5 and -2.5 minutes from T; the window's own centre is -7.5.
    // Interpolating between centres means the first bucket leans on `prev` and the last on `next`.
    const raw =
      prev === null && next === null
        ? // 🛑 Nothing to lean on either side: hold flat. Fitting a slope through one point is
          // extrapolation, which is the thing derive-power.ts refuses to do.
          [value, value, value]
        : [
            prev === null ? value : value + (prev - value) / 3,
            value,
            next === null ? value : value + (next - value) / 3,
          ];
    const held = prev === null && next === null;

    // 🛑 Rescale so the triple's MEAN is exactly the recorded average. The smoothing is a rendering
    // choice; the interval's energy is a fact, and `recomputeAgg1dForDay` sums it.
    const mean = (raw[0] + raw[1] + raw[2]) / 3;
    const scaled =
      mean === 0
        ? // A mean of zero cannot be scaled to a non-zero target, and does not need to be: the only
          // way to reach it from a linear fit through the neighbours is for all three to be zero.
          raw
        : raw.map((v) => (v * value) / mean);

    for (let i = 0; i < 3; i++)
      out.push({
        startMs: tMs - FIFTEEN_MIN_MS + i * FIVE_MIN_MS,
        value: scaled[i],
        held,
      });
  }
  return out;
}

/**
 * Spread a series of INSTANTANEOUS values (SoC) onto the 5-minute grid.
 *
 * 🛑 A 5-minute bucket is `(end-5, end]`, and an instantaneous reading at T is the LAST sample of
 * the bucket ENDING at T — so it belongs to `interval_start = T - 5min`, not to the bucket starting
 * at T. Measured against LiveOne over 2026-08 (n = 2 969), matching SP LINK's stamp T against the
 * row whose interval_end is T: r = 0.999996, median absolute difference 0.011 %, against 0.999921
 * and 0.044 % one bucket later. That is the same conclusion the averages reach from the other side
 * — a window `(T-15, T]` covers the buckets ending T-10, T-5 and T, i.e. starting T-15, T-10 and
 * T-5 — so the two agree that this window's last bucket starts at T-5.
 *
 * This was wrong in the first cut, in the one direction nothing downstream could detect: every SoC
 * row landed a single interval late, which for a slowly-moving series looks entirely plausible.
 *
 * 🛑 Bounded to a single 15-minute step. A longer span is a hole the archive itself has, and a
 * straight line across it would be invention rather than recovery.
 */
export function resampleInstant(
  byT: Array<{ tMs: number; value: number | null }>,
): Resampled[] {
  const out: Resampled[] = [];
  for (let i = 0; i < byT.length; i++) {
    const { tMs, value } = byT[i];
    if (value === null) continue;
    // The bucket this reading ENDS: start = T - 5min.
    const startMs = tMs - FIVE_MIN_MS;
    out.push({ startMs, value, held: false });

    const next = byT[i + 1];
    if (!next || next.value === null) continue;
    if (next.tMs - tMs !== FIFTEEN_MIN_MS) continue; // not adjacent — do not bridge it
    for (let k = 1; k <= 2; k++)
      out.push({
        startMs: startMs + k * FIVE_MIN_MS,
        value: value + ((next.value - value) * k) / 3,
        held: false,
      });
  }
  return out;
}

// =================================================================================================
// The energy counters.
// =================================================================================================
/**
 * Reconstructing LiveOne's LIFETIME energy counters from SP LINK's DAILY accumulators.
 *
 * This is a different job from everything above, and it is a much better-founded one: the
 * quantities here are the inverter's own metered energy, not an identity over its power columns.
 * What has to be reconstructed is only the SHAPE inside each 15-minute window and the OFFSET the
 * whole run sits at.
 *
 * ## 1. The archive's accumulators reset at local midnight
 *
 * `*_accumulated_kwh` are DAY totals, not lifetime counters — measured, not assumed. Across
 * 2026-09-11T00:00 local (2026-09-10T14:00Z) `ac_load_accumulated_kwh` steps 29.2069 → 0.6832
 * while `load_ac_power_average_kw` holds flat at ~2.8 kW either side. So a window's energy is
 * `value - previous`, except at the reset, where the value IS the increment.
 *
 * 🛑 The reset is detected by the value FALLING, not by a clock. A UTC-day rule would be wrong (the
 * site is +10) and a local-midnight rule would still be a guess about the inverter's own
 * bookkeeping. A counter that only ever rises within a day makes the fall unambiguous.
 *
 * ## 2. LiveOne's counters are LIFETIME, so the run needs an anchor
 *
 * `1/load/energy` reads 5,584,502 Wh, and `liveone import` computes each row's `delta` against the
 * immediately preceding `last`. Writing the archive's 0.68 kWh into that column would difference
 * against five and a half million and produce one catastrophic interval. So the increments are
 * CHAINED onto the last stored reading before the run.
 *
 * ## 3. Nothing is scaled to fit
 *
 * The chain is checked against the first stored reading AFTER the run, and the check passes on its
 * own. Over Daylesford's 2026-09-10T14:00Z→22:30Z outage (34 windows tiling 510 minutes exactly):
 *
 *   series        LiveOne Δ      archive     leftover
 *   solar             2 959 Wh     2 788 Wh     171 Wh
 *   load             22 802       22 546        256
 *   battery.charge        0            0          0
 *   battery.discharge 21 595       21 502         93
 *   grid.import           0            0          0
 *   grid.export           0            0          0
 *
 * The leftover is what the ONE interval between the run's end and the next stored reading must
 * hold, and it is a plausible interval in its own right — 3.07 kW of load, 2.05 kW of solar and
 * 1.12 kW of discharge — which balances to 3.1 %, about an inverter's efficiency. Two independent
 * instruments agreeing to one interval over 8.5 hours is the evidence that no fitted constant is
 * needed here, and a `--counters` run REFUSES when the leftover is not one plausible interval
 * rather than quietly scaling to hide the disagreement.
 *
 * ## 4. Splitting a window across its three buckets
 *
 * The window's energy is a fact; where it sits inside the window is not. Each increment is split in
 * proportion to the reconstructed POWER shape for the same quantity — the one `resampleAverages`
 * already produces, whose triple-mean is exactly the recorded average. So the split is consistent
 * with the power series imported beside it, and a flat window stays flat. Where the shape is
 * absent, zero, or would go negative, the increment is split in equal thirds: a counter cannot run
 * backwards, and an equal split preserves the window's energy exactly, which is the only property
 * `recomputeAgg1dForDay` reads.
 */

/** The LiveOne energy counters this produces, and the archive column each accumulates. */
export const ACCUMULATED: Array<{
  /** LiveOne's logical path for the counter point. */
  series: string;
  /** The archive's day-accumulator column. */
  columns: Array<{ name: string; scale: number }>;
  /** The power series whose reconstructed shape splits each window, if any. */
  shape?: Series;
}> = [
  {
    series: "source.solar/energy",
    // Solar is the same two halves the power identity uses: the DC-coupled shunt (sign inverted at
    // this site, exactly as `shunt1_current_average_a` is) plus the AC-coupled sample.
    columns: [
      { name: "shunt1_accumulated_kwh", scale: -1 },
      { name: "ac_coupled_energy_sample_kwh", scale: 1 },
    ],
    shape: "source.solar/power",
  },
  {
    series: "load/energy",
    columns: [{ name: "ac_load_accumulated_kwh", scale: 1 }],
    shape: "load/power",
  },
  {
    series: "bidi.battery.charge/energy",
    columns: [{ name: "battery_in_accumulated_kwh", scale: 1 }],
  },
  {
    series: "bidi.battery.discharge/energy",
    columns: [{ name: "battery_out_accumulated_kwh", scale: 1 }],
  },
  {
    series: "bidi.grid.import/energy",
    columns: [{ name: "ac_input_accumulated_kwh", scale: 1 }],
  },
  {
    series: "bidi.grid.export/energy",
    columns: [{ name: "ac_export_accumulated_kwh", scale: 1 }],
  },
];

/**
 * Per-window increments of one day-resetting accumulator, in the accumulator's own unit.
 *
 * `byT` must be sorted ascending and evenly spaced; a window whose predecessor is missing yields
 * null, because the increment is unknowable without it. The FIRST window is null for the same
 * reason — which is why a caller reads one record of padding before the run it wants.
 */
export function accumulatorIncrements(
  byT: Array<{ tMs: number; value: number | null }>,
): Array<{ tMs: number; increment: number | null }> {
  const out: Array<{ tMs: number; increment: number | null }> = [];
  let prev: { tMs: number; value: number } | null = null;
  for (const { tMs, value } of byT) {
    if (value === null) {
      out.push({ tMs, increment: null });
      continue;
    }
    let increment: number | null;
    if (prev === null || tMs - prev.tMs !== FIFTEEN_MIN_MS) {
      // No adjacent predecessor: the increment is unknowable. Never treat the raw value as one —
      // outside a reset it is a day-to-date total, and importing it would invent a day of energy.
      increment = null;
    } else if (value < prev.value) {
      // The day rolled over: the new value is itself the first window's energy.
      increment = value;
    } else {
      increment = value - prev.value;
    }
    out.push({ tMs, increment });
    prev = { tMs, value };
  }
  return out;
}

/**
 * Split one window's energy across its three 5-minute buckets, in proportion to `shape`.
 *
 * Returns the three bucket energies, which always sum to `increment` exactly.
 */
export function splitIncrement(
  increment: number,
  shape: [number, number, number] | null,
): [number, number, number] {
  const third = increment / 3;
  if (shape === null) return [third, third, third];
  // A counter cannot run backwards, so a negative shape cannot weight it. Clamping rather than
  // refusing keeps a window with one negative bucket (a brief reverse flow inside an otherwise
  // forward window) from discarding the whole window's energy.
  const w = shape.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = w[0] + w[1] + w[2];
  if (sum <= 0) return [third, third, third];
  const out: [number, number, number] = [
    (increment * w[0]) / sum,
    (increment * w[1]) / sum,
    (increment * w[2]) / sum,
  ];
  // Push the rounding residue into the last bucket so the three sum to `increment` exactly.
  out[2] = increment - out[0] - out[1];
  return out;
}
