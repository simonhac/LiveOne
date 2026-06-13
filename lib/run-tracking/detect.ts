/**
 * Pure run-period detection — turn periodic point samples into coalesced run periods.
 *
 * This is the device-runtime analogue of `lib/aggregation/point-aggregates.ts`: a DB-free,
 * deterministic state machine, unit-tested in isolation, with the DB recompute layer
 * (`lib/db/planetscale/run-periods-pg.ts`) a thin shell around it.
 *
 * It implements Home Assistant's vocabulary — a *threshold helper* (a power point + `lower`/
 * `upper` bound + `hysteresis` deadband) feeding a *binary_sensor* with `delay_on`/`delay_off`
 * anti-flap — but with **reconstruction** semantics suited to sample-based data: we coalesce
 * gaps and drop short runs rather than padding the reported interval the way HA's live delays do.
 *
 * `nowMs` is injected (never `Date.now()` here) so detection is deterministic and resumable.
 */

/** One sample of the signal point. `value` is Watts (power) or null for an error/missing reading. */
export interface Sample {
  /** measurement_time as epoch-ms (UTC). */
  tMs: number;
  value: number | null;
}

export interface DetectConfig {
  /** HA threshold `lower`: ON when value < lower. At least one of lower/upper must be set. */
  lowerW?: number | null;
  /** HA threshold `upper`: ON when value > upper. */
  upperW?: number | null;
  /** HA threshold deadband (±W around the bound) that latches state to kill flapping. Default 0. */
  hysteresisW?: number | null;
  /** HA delay_on: drop closed runs whose span < this (spikes). The open run is exempt. */
  delayOnMs: number;
  /**
   * HA delay_off: the max gap between consecutive on-samples that still counts as one run.
   * Once there has been no on-sample for delayOffMs the run is closed at its last on-sample;
   * this also decides whether the final run is left open (running now). Folds in "staleness".
   */
  delayOffMs: number;
  /** Recompute "as of" time (epoch-ms), injected. The final run stays open iff now − lastOn ≤ delayOff. */
  nowMs: number;
  /**
   * Boundary assignment. "edge" (default) uses the first/last on-sample. "midpoint" places the
   * start midway between the previous (off) sample and the first on-sample for an unbiased
   * duration; the end always falls back to the last on-sample (runs close on a gap, not an edge).
   */
  boundaryMode?: "edge" | "midpoint";
}

export type CloseReason = "gap" | null;

export interface DetectedPeriod {
  startMs: number;
  /** null = open (running now). */
  endMs: number | null;
  sampleCount: number;
  /** Max/min/avg of the raw on-sample values (signed — e.g. grid import is negative). */
  maxW: number | null;
  minW: number | null;
  avgW: number | null;
  closeReason: CloseReason;
}

/** Sort ascending by time and collapse exact-duplicate timestamps (last value wins). */
function normalizeSamples(samples: Sample[]): Sample[] {
  const sorted = [...samples].sort((a, b) => a.tMs - b.tMs);
  const out: Sample[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.tMs === s.tMs) out[out.length - 1] = s;
    else out.push(s);
  }
  return out;
}

/**
 * Latched ON/OFF classifier with a hysteresis deadband. `prevOn` is the current latched state,
 * held when the value sits inside the deadband. With hysteresis 0 this reduces to a strict
 * comparison with a hold exactly at the bound (so the boundary value is deterministic given the
 * prior state) — matching the legacy `value < threshold` behaviour.
 */
function classify(value: number, cfg: DetectConfig, prevOn: boolean): boolean {
  const h = Math.abs(cfg.hysteresisW ?? 0);
  if (cfg.lowerW != null) {
    if (value < cfg.lowerW - h) return true; // clearly below ⇒ on
    if (value > cfg.lowerW + h) return false; // clearly above ⇒ off
    return prevOn; // deadband ⇒ hold
  }
  if (cfg.upperW != null) {
    if (value > cfg.upperW + h) return true;
    if (value < cfg.upperW - h) return false;
    return prevOn;
  }
  return false;
}

interface OpenRun {
  startMs: number;
  firstOnMs: number;
  lastOnMs: number;
  count: number;
  sum: number;
  max: number;
  min: number;
}

function finalize(
  run: OpenRun,
  endMs: number | null,
  closeReason: CloseReason,
): DetectedPeriod {
  return {
    startMs: run.startMs,
    endMs,
    sampleCount: run.count,
    maxW: run.count > 0 ? run.max : null,
    minW: run.count > 0 ? run.min : null,
    avgW: run.count > 0 ? run.sum / run.count : null,
    closeReason,
  };
}

/**
 * Coalesce time-ordered samples into run periods.
 *
 * Rules: a run opens on the first on-sample and stays open while on-samples keep arriving within
 * `delayOffMs` of each other (brief off/null samples within the gap are bridged). A sample (on,
 * off, or null) arriving more than `delayOffMs` after the last on-sample closes the run at that
 * last on-sample; an on-sample beyond the gap starts a new run. The final run is left open
 * (endMs = null) iff `now − lastOn ≤ delayOffMs`. Closed runs shorter than `delayOnMs` are
 * dropped (the open run is exempt). Metrics are over the raw on-sample values.
 */
export function detectRunPeriods(
  samples: Sample[],
  cfg: DetectConfig,
): DetectedPeriod[] {
  if (cfg.lowerW == null && cfg.upperW == null) {
    throw new Error(
      "detectRunPeriods: at least one of lowerW/upperW is required",
    );
  }
  const midpoint = cfg.boundaryMode === "midpoint";
  const rows = normalizeSamples(samples);

  const periods: DetectedPeriod[] = [];
  let state = false; // latched on/off
  let run: OpenRun | null = null;
  let prevSampleMs: number | null = null; // for midpoint start boundary

  for (const s of rows) {
    // Gap-close: any sample beyond delayOff from the last on-sample ends the open run.
    if (run && s.tMs - run.lastOnMs > cfg.delayOffMs) {
      periods.push(finalize(run, run.lastOnMs, "gap"));
      run = null;
      state = false;
    }

    if (s.value === null) {
      // Error/missing: counts toward the gap clock (handled above) but is not classified.
      prevSampleMs = s.tMs;
      continue;
    }

    const on = classify(s.value, cfg, state);
    state = on;

    if (on) {
      if (!run) {
        const startMs =
          midpoint && prevSampleMs != null ? (prevSampleMs + s.tMs) / 2 : s.tMs;
        run = {
          startMs,
          firstOnMs: s.tMs,
          lastOnMs: s.tMs,
          count: 1,
          sum: s.value,
          max: s.value,
          min: s.value,
        };
      } else {
        run.lastOnMs = s.tMs;
        run.count += 1;
        run.sum += s.value;
        if (s.value > run.max) run.max = s.value;
        if (s.value < run.min) run.min = s.value;
      }
    }
    // off-sample: leave the run open (delay_off bridging); the gap-close above will end it.
    prevSampleMs = s.tMs;
  }

  // Tail: the final run is open iff its last on-sample is recent; else close it (gap).
  if (run) {
    if (cfg.nowMs - run.lastOnMs <= cfg.delayOffMs) {
      periods.push(finalize(run, null, null));
    } else {
      periods.push(finalize(run, run.lastOnMs, "gap"));
    }
  }

  // delay_on: drop short closed runs; never drop the open one.
  return periods.filter(
    (p) => p.endMs === null || p.endMs - p.startMs >= cfg.delayOnMs,
  );
}
