/**
 * Pure per-run energy attribution — batched, counter-reset safe.
 *
 * Replaces the old generator-events N+1 (one query per event). The DB layer fetches the energy
 * point's readings for the whole recompute window ONCE; this assigns each run its energy by a
 * linear merge over the sorted readings. No DB here.
 *
 * The energy point is a monotonic cumulative counter (point_info.transform='d', e.g. the grid
 * `Import` point), valued in Wh. A counter reset (a decrease between readings) contributes nothing.
 *
 * 🛑 THE COUNTER IS PARTITIONED ACROSS THE RUN BOUNDARY, NOT CLIPPED TO IT — see
 * {@link allocateCounterToWindows}. The earlier rule ("last − first reading INSIDE the window") threw
 * away the counter step that straddles a run's start, which on a coarse meter is a whole quantum: the
 * Kinkora EV charger reports in ~400 Wh ticks every ~4-6 minutes, so three of six sessions in a
 * sample week lost 0.27-0.40 kWh each (11% of a short session) while the other three, whose ticks
 * happened to land clear of the boundary, were exact. That is phase luck, not measurement error, and
 * it is why the run totals sat ~1.0 kWh under the Sankey's `load.ev` for the same span.
 *
 * `assignProvenanceToPeriods` integrates cost/emissions/renewable over the SAME allocation — both
 * functions call the one allocator, so they cannot disagree about which slices exist.
 */
import { roundToThree } from "@/lib/history/format-opennem";
import type { IntensitySeries } from "./intensity";

export interface EnergyReading {
  /** epoch-ms (UTC). */
  tMs: number;
  /** cumulative Wh, or null for an error/missing reading. */
  value: number | null;
}

export interface EnergyWindow {
  startMs: number;
  /** null = open run; its window extends to nowMs. */
  endMs: number | null;
}

/**
 * A sample of the run detector's SIGNAL point — the shape function energy is allocated by.
 *
 * The signal is the right weight precisely because it is what DEFINED the run: the detector calls the
 * device "on" above a threshold, so the same series that placed the boundary also says how the
 * straddling step's energy was distributed either side of it. (For the EV that is Watts; for a
 * generator it is engine rpm. Neither is energy, but only the RATIO within one counter step is used,
 * and both are monotone in "how hard the thing was working" — which is the detector's own model of
 * the device.) Negative values are clamped to 0: a weight cannot be negative.
 */
export interface SignalSample {
  tMs: number;
  value: number | null;
}

/** One window's share of one counter step. */
export interface CounterSlice {
  /** kWh allocated to the window from this step. Zero is a real answer (the counter did not move). */
  kwh: number;
  /**
   * The instant this share had accrued BY — the END of the overlap. Right-closed, matching
   * `stepIntensity`'s lookup: energy that accrued over `(a, b]` is priced at `b`.
   */
  tMs: number;
}

const KWH_DP = 1000; // round to 3 decimal places (kWh stored to 3dp)

/** 3dp — the stored precision for kWh, and enough for sub-cent / sub-gram provenance. */
function round3(v: number): number {
  return Math.round(v * KWH_DP) / KWH_DP;
}

/**
 * Split every counter step across the windows it touches. The ONE place run energy is decided.
 *
 * Each consecutive pair of valid readings is a step spanning `(a.tMs, b.tMs]` carrying `b − a` Wh.
 * The step is divided among the windows that overlap it in proportion to the integral of the signal
 * over each overlap, with the remainder left to the gaps between runs. Hence the property that makes
 * this "complete" rather than "less wrong":
 *
 *   **Σ(all windows) + Σ(gaps) == Σ(positive counter deltas)** — exactly, for any set of windows.
 *
 * Nothing is dropped at a boundary and nothing is double-counted, and both ends are handled by the
 * same mechanism: because the EV circuit reads exactly 0 W when it is not charging, the step
 * straddling a run's START lands wholly inside the run (all of its signal is inside), and the step
 * straddling its END keeps only the part before the charger stopped. No special case, and no
 * dependence on the detector's `midpoint` start convention.
 *
 * Returns one entry per window, index-aligned. **null means the counter said nothing about this
 * window** — no pair of readings spans any part of it — which is `unknown`, not zero. An empty-but-
 * non-null array cannot happen: a step that overlaps always emits a slice, `kwh: 0` when the counter
 * did not advance, so a run that aborts before the meter ticks reports a KNOWN 0.000 kWh and a KNOWN
 * $0.00 rather than an unknown. Coverage is decided BEFORE the reset guard, so a window sitting
 * entirely inside a counter wrap is still "known", exactly as it was when the guard was inline.
 */
export function allocateCounterToWindows(
  windows: EnergyWindow[],
  readings: EnergyReading[],
  nowMs: number,
  signal?: SignalSample[],
): (CounterSlice[] | null)[] {
  const valid = sortValid(readings);
  const bounds = windows.map((w) => ({
    lo: w.startMs,
    hi: w.endMs ?? nowMs,
  }));
  const out: (CounterSlice[] | null)[] = windows.map(() => null);
  // The run EDGES are handed to the integrator as transition instants: the detector has already ruled
  // that the device switched there, so the signal must be reconstructed as a step at that instant
  // rather than a ramp through it. See `signalIntegrator`.
  const edges = bounds.flatMap((b) => [b.lo, b.hi]);
  const weigh = signalIntegrator(signal, edges);

  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1];
    const b = valid[i];
    if (b.tMs <= a.tMs) continue; // duplicate timestamps carry no span to divide

    // Overlaps first, and independently of whether the step carries energy — that is what keeps
    // "known 0.000" distinct from "unknown".
    const overlaps: { w: number; lo: number; hi: number }[] = [];
    for (let k = 0; k < bounds.length; k++) {
      const lo = Math.max(a.tMs, bounds[k].lo);
      const hi = Math.min(b.tMs, bounds[k].hi);
      if (hi <= lo) continue;
      overlaps.push({ w: k, lo, hi });
      if (out[k] === null) out[k] = [];
    }
    if (overlaps.length === 0) continue;

    // Reset-safe, exactly as before: a negative step is a counter wrap/reboot, not energy. It still
    // emits its zero-kWh slices above, so the factor is read and the window stays "known".
    const delta = b.value - a.value;
    const kwh = delta > 0 ? delta / 1000 : 0;

    const total = weigh(a.tMs, b.tMs);
    for (const o of overlaps) {
      // With no usable signal over this step (none loaded, all-null, or a flat zero against a counter
      // that nonetheless advanced) fall back to time-proportional — the honest prior when the shape
      // is unknown, and the exact answer for a constant load.
      const share =
        total > 0 ? weigh(o.lo, o.hi) / total : (o.hi - o.lo) / (b.tMs - a.tMs);
      out[o.w]!.push({ kwh: kwh * share, tMs: o.hi });
    }
  }

  return out;
}

/** Energy (kWh, 3dp) per window from an allocation already computed. */
export function energyFromAllocation(
  alloc: (CounterSlice[] | null)[],
): (number | null)[] {
  return alloc.map((slices) =>
    slices === null ? null : round3(slices.reduce((sum, s) => sum + s.kwh, 0)),
  );
}

/**
 * Energy (kWh, 3dp) for each window, aligned by index. `readings` need not be sorted.
 * For an open window (endMs null) the window upper bound is `nowMs`.
 *
 * Convenience wrapper. The production recompute allocates ONCE and feeds both
 * {@link energyFromAllocation} and {@link provenanceFromAllocation}, so the two cannot be handed
 * different slices.
 */
export function assignEnergyToPeriods(
  windows: EnergyWindow[],
  readings: EnergyReading[],
  nowMs: number,
  signal?: SignalSample[],
): (number | null)[] {
  return energyFromAllocation(
    allocateCounterToWindows(windows, readings, nowMs, signal),
  );
}

/**
 * Cost (cents), emissions (grams CO₂), renewable energy (kWh) and estimated energy (kWh) attributed
 * to one run.
 */
export interface PeriodProvenance {
  costC: number | null;
  emissionsG: number | null;
  renewableKwh: number | null;
  /**
   * kWh whose source intensity was estimated or unknown — `estimated_kwh` for a run, with exactly
   * the meaning `point_readings_flow_attr_1d.estimated_kwh` carries for a day. It is the CONFIDENCE
   * denominator for the three figures above: when a source cannot be priced its energy contributes
   * nothing to `costC` (the Sankey does the same), so a run can read cheap for a reason this number
   * is the only record of.
   *
   * Null ONLY when nothing at all is known — no allocation, or no intensity series for the device.
   * A run whose every slice was unpriceable carries its WHOLE energy here, never 0.
   */
  estimatedKwh: number | null;
}

/** "Nothing is known about this run's provenance" — the value for an unpriced device. */
export const NO_PROVENANCE: PeriodProvenance = {
  costC: null,
  emissionsG: null,
  renewableKwh: null,
  estimatedKwh: null,
};

/**
 * Per-run cost / emissions / renewable energy — the ENERGY-WEIGHTED INTEGRAL `Σ sliceKwh × factor`
 * over the run, NOT `energy × constant`.
 *
 * Integrates over the SAME allocation `assignEnergyToPeriods` sums, obtained from the same call to
 * `allocateCounterToWindows`, so the slices are the counter's own (~1-minute) steps — finer than the
 * 5-minute flow timeline, aligned with the run's metered energy by construction, and, since the
 * allocator partitions rather than clips, with no truncation at either edge. A slice is priced at the
 * END of its own overlap — the instant the counter reports that energy as delivered.
 *
 * Each accumulator is INDEPENDENTLY null when its factor is unknown across the whole run, so a site
 * that configures emissions but no price reports emissions and OMITS cost rather than claiming
 * $0.00. A window the counter never spanned ⇒ all null, matching the energy path (unknown ≠ zero).
 * `estimatedKwh` is the exception and deliberately so — see `PeriodProvenance`.
 *
 * With a constant series (the off-grid generator) this reduces exactly to `energy × factor` — the
 * degenerate case of the same integral, not a separate code path.
 */
export function assignProvenanceToPeriods(
  windows: EnergyWindow[],
  readings: EnergyReading[],
  series: IntensitySeries,
  nowMs: number,
  signal?: SignalSample[],
): PeriodProvenance[] {
  return provenanceFromAllocation(
    allocateCounterToWindows(windows, readings, nowMs, signal),
    series,
  );
}

/** Provenance per window from an allocation already computed. */
export function provenanceFromAllocation(
  alloc: (CounterSlice[] | null)[],
  series: IntensitySeries,
): PeriodProvenance[] {
  return alloc.map((slices) => {
    if (slices === null) return NO_PROVENANCE;

    // Null until a factor is known to apply, then a running sum — so "unknown" and "genuinely
    // zero" stay distinct without a parallel set of `any*` flags to keep in step.
    let costC: number | null = null;
    let emissionsG: number | null = null;
    let renewableKwh: number | null = null;
    // Same discipline, but `estimatedFraction` is never null, so this becomes a number the moment
    // any slice exists. That asymmetry is the point:
    //   - an unpriced DEVICE has no series at all, so this function is never called for it and
    //     NO_PROVENANCE's null stands;
    //   - a window the counter never spanned returns NO_PROVENANCE above — null, matching energy;
    //   - a fully-unpriceable RUN accumulates fraction 1 per slice → estimatedKwh === energyKwh.
    // Zero must never stand in for "we don't know" on a confidence denominator: that is the one
    // reading which turns a run nothing could price into a claim that everything was priced.
    let estimatedKwh: number | null = null;

    for (const s of slices) {
      const f = series.at(s.tMs);
      if (f.priceC != null) costC = (costC ?? 0) + s.kwh * f.priceC;
      if (f.gPerKwh != null) emissionsG = (emissionsG ?? 0) + s.kwh * f.gPerKwh;
      if (f.renewable != null)
        renewableKwh = (renewableKwh ?? 0) + s.kwh * f.renewable;
      estimatedKwh = (estimatedKwh ?? 0) + s.kwh * f.estimatedFraction;
    }

    // Rounded to the stored 3dp so accumulated float noise (…299999999997 cents) never reaches the
    // column; well below any displayed precision.
    return {
      costC: roundToThree(costC),
      emissionsG: roundToThree(emissionsG),
      renewableKwh: roundToThree(renewableKwh),
      estimatedKwh: roundToThree(estimatedKwh),
    };
  });
}

function sortValid(
  readings: EnergyReading[],
): { tMs: number; value: number }[] {
  return readings
    .filter((r): r is { tMs: number; value: number } => r.value !== null)
    .sort((a, b) => a.tMs - b.tMs);
}

/**
 * `(lo, hi) => ∫ signal dt` over the reconstructed signal, as a prefix-sum lookup.
 *
 * Only RATIOS within one counter step are ever taken, so the units and the interpolation constant
 * cancel — what matters is that the shape is monotone in device activity and that the integral is
 * additive over adjacent spans (`∫(a,c) == ∫(a,b) + ∫(b,c)`), which is what makes the partition sum
 * back to the whole. Outside the sampled span the integral is flat, so a step reaching past the
 * signal contributes no weight there and the caller's time-proportional fallback takes over.
 *
 * 🛑 THE RECONSTRUCTION IS LINEAR EXCEPT ACROSS A `transition` — and that exception is the point.
 * A charger switching 0 → 5 kW is sampled, so plain interpolation spreads the switch as a ramp across
 * the sample either side of it, and half that ramp's area lands BEFORE the run's detected start. The
 * energy then gets booked to a period during which this system says the device was off — which is not
 * a rounding difference, it is self-contradictory. The detector has already committed to an instant
 * (`boundaryMode: "midpoint"` puts it halfway between the last off-sample and the first on-sample),
 * so within a sample gap containing that instant the signal is reconstructed as a STEP there: the
 * left sample's value holds up to the transition, the right sample's value from it. One event,
 * modelled once, in agreement with the boundary it produced.
 *
 * Everywhere else the reconstruction stays linear, matching the trapezoid the flow matrix integrates
 * power with — so this buys agreement at the edges without introducing a second convention inside.
 */
function signalIntegrator(
  samples: SignalSample[] | undefined,
  transitions: number[] = [],
): (lo: number, hi: number) => number {
  const base = (samples ?? [])
    .filter((s): s is { tMs: number; value: number } => s.value !== null)
    .map((s) => ({ tMs: s.tMs, value: Math.max(0, s.value) }))
    .sort((a, b) => a.tMs - b.tMs);
  if (base.length < 2) return () => 0;

  // Materialise each transition as a coincident pair (left value, then right value) so the trapezoid
  // between them has zero width and the jump is exact.
  const pts: { tMs: number; value: number }[] = [];
  const sorted = [...new Set(transitions)].sort((a, b) => a - b);
  let ti = 0;
  for (let i = 0; i < base.length; i++) {
    pts.push(base[i]);
    const next = base[i + 1];
    if (!next) break;
    while (ti < sorted.length && sorted[ti] <= base[i].tMs) ti++;
    // Half-open on the left, CLOSED on the right: a transition landing exactly on the next sample
    // still has to suppress the ramp leading INTO it. Detectors routinely produce that — a
    // `midpoint` boundary lands on a sample whenever the off→on pair is one cadence apart — and
    // leaving it to interpolate is what leaks a slice of the run's energy into the preceding gap.
    while (ti < sorted.length && sorted[ti] <= next.tMs) {
      pts.push({ tMs: sorted[ti], value: base[i].value }); // hold the left value up to the switch…
      pts.push({ tMs: sorted[ti], value: next.value }); // …then jump to the right one
      ti++;
    }
  }

  const prefix = new Array<number>(pts.length).fill(0);
  for (let i = 1; i < pts.length; i++)
    prefix[i] =
      prefix[i - 1] +
      ((pts[i].value + pts[i - 1].value) / 2) * (pts[i].tMs - pts[i - 1].tMs);

  const at = (t: number): number => {
    if (t <= pts[0].tMs) return 0;
    const last = pts.length - 1;
    if (t >= pts[last].tMs) return prefix[last];
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].tMs <= t) lo = mid;
      else hi = mid - 1;
    }
    const p0 = pts[lo];
    const p1 = pts[lo + 1];
    // A transition materialises as a coincident pair, so a zero-width segment is expected here and
    // contributes nothing. Guarding is not defensive padding: interpolating across it divides by 0.
    if (p1.tMs === p0.tMs) return prefix[lo];
    const v =
      p0.value + ((p1.value - p0.value) * (t - p0.tMs)) / (p1.tMs - p0.tMs);
    return prefix[lo] + ((p0.value + v) / 2) * (t - p0.tMs);
  };

  return (lo, hi) => Math.max(0, at(hi) - at(lo));
}
