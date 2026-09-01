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
  /**
   * Floor `delayOffMs` at this multiple of the OBSERVED interval between on-samples. Default
   * {@link DEFAULT_DELAY_OFF_CADENCE_MULTIPLE}; 0 disables the floor.
   *
   * 🛑 THE UNITS BUG THIS FIXES. `delayOffMs` is compared against `s.tMs - run.lastOnMs` — a SAMPLE
   * GAP — so any threshold on it is only meaningful in multiples of the sampling interval, yet it is
   * configured in absolute seconds. The `ev` role default of 300 s was sized against Kinkora Mondo,
   * whose EV point polls at a 120 s median: 2.5x cadence, comfortable. Pointed at the Sigenergy
   * charger, which polls every ~300 s, the same 300 s is 1.0x — and 31 of 74 measured gaps exceeded
   * it, so one six-hour charge was detected as 25 runs of 3-8 minutes.
   *
   * `delayOffMs` is really doing two jobs. The MERGE POLICY ("an unplug/replug inside five minutes is
   * one session") is a genuine per-role choice and stays in `defaults.ts`. GAP TOLERANCE — surviving
   * a late or dropped poll — is not per-role at all; it is a function of the cadence, and only the
   * data knows it. So the effective value is `max(policy, k × cadence)`: the floor can only ever
   * MERGE more, never fragment more, so it cannot regress a detector that works today.
   */
  delayOffCadenceMultiple?: number;
  /** Recompute "as of" time (epoch-ms), injected. The final run stays open iff now − lastOn ≤ delayOff. */
  nowMs: number;
  /**
   * Boundary assignment. "edge" (default) uses the first/last on-sample. "midpoint" places the
   * start midway between the previous (off) sample and the first on-sample for an unbiased
   * duration; the end always falls back to the last on-sample (runs close on a gap, not an edge).
   */
  boundaryMode?: "edge" | "midpoint";
  /**
   * Times (epoch-ms, any order) at which the CONTROL signal changed — for a generator, the edges of
   * the hub's commanded-run point. A run is cut at one of these rather than being bridged.
   *
   * Why this exists: `delayOffMs` is anti-flap, and it cannot tell a sensor blink from a deliberate
   * stop-and-restart. On 2026-08-30 a commanded stop and a commanded restart 45 s apart (the engine
   * genuinely off in between) were merged into one run by the 120 s deadband, so the tile reported
   * a run that had just been started as already 3 minutes old and charged the new run's energy to
   * the old one. The engine's own signal cannot resolve that — two identical off-gaps, one a blink
   * and one a stop, look the same. The command does resolve it, which is why it is an input here.
   *
   * 🛑 An edge only splits across an off-gap — never between two consecutive on-samples. The DSE
   * cools down for ~90 s AFTER the stop command, so the stop edge lands mid-run while the engine is
   * still turning; splitting there would file the cool-down tail as a second run that nobody
   * started. The tail belongs to the run that caused it; only the next start opens a new one.
   */
  boundaryEventsMs?: number[];
}

/**
 * Gap tolerance, in multiples of the observed on-sample cadence. 2x is too tight — one dropped poll
 * is already 2x plus jitter — so 3x, which survives a dropped poll comfortably. Against the three
 * live detectors: Kutis EV 3x300s = 900s (fixes it), Kinkora EV 3x120s = 360s (only bites on gaps in
 * (300,360], and its measured max is 184s), Daylesford generator 3x60s = 180s < its 240s policy
 * (unchanged).
 */
export const DEFAULT_DELAY_OFF_CADENCE_MULTIPLE = 3;

/**
 * Fewest ON-sample intervals needed before their median is taken to describe a cadence. Below this
 * the window has not shown a rhythm — a couple of intervals is noise — and no floor is applied, so
 * the configured `delayOffMs` stands exactly as it does today.
 */
const MIN_ON_INTERVALS_FOR_CADENCE = 4;

export type CloseReason = "gap" | "boundary" | null;

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

/**
 * Median interval between CONSECUTIVE on-samples, or null when the window has not shown enough of a
 * rhythm to say. Pure; measured from the same rows the detector is about to walk.
 *
 * 🛑 ON-samples specifically, never every sample — and the Daylesford generator is why. The DeepSea
 * hub polls at 300 s while idle and 60 s while the engine runs, so a median over the whole window is
 * dominated by idle samples and would floor `delayOff` at 900 s, bridging fifteen-minute gaps and
 * merging genuinely separate generator runs. The cadence that governs whether a RUN survives a poll
 * gap is the cadence WHILE RUNNING, which is 60 s.
 *
 * Classification here is unlatched (`prevOn = false`, i.e. the turn-on test) because this needs a
 * cadence, not a state machine: a sample sitting inside the hysteresis deadband is genuinely
 * ambiguous and contributes no interval either way. Pairs straddling an off-sample are skipped, so
 * an idle stretch never widens the measured rhythm.
 */
export function medianOnSampleIntervalMs(
  samples: Sample[],
  cfg: DetectConfig,
): number | null {
  const rows = normalizeSamples(samples);
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.value === null || b.value === null) continue;
    if (!classify(a.value, cfg, false) || !classify(b.value, cfg, false))
      continue;
    const gap = b.tMs - a.tMs;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < MIN_ON_INTERVALS_FOR_CADENCE) return null;
  gaps.sort((x, y) => x - y);
  const mid = gaps.length >> 1;
  return gaps.length % 2
    ? gaps[mid]
    : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

/**
 * The `delayOffMs` detection will actually use: the configured merge policy, floored at
 * `k x` the observed on-sample cadence. See {@link DetectConfig.delayOffCadenceMultiple}.
 */
export function effectiveDelayOffMs(
  samples: Sample[],
  cfg: DetectConfig,
): number {
  const k = cfg.delayOffCadenceMultiple ?? DEFAULT_DELAY_OFF_CADENCE_MULTIPLE;
  if (k <= 0) return cfg.delayOffMs;
  const cadence = medianOnSampleIntervalMs(samples, cfg);
  return cadence === null
    ? cfg.delayOffMs
    : Math.max(cfg.delayOffMs, cadence * k);
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
 * last on-sample; an on-sample beyond the gap starts a new run. An on-sample that resumes after an
 * OFF stretch containing a control edge (`boundaryEventsMs`) also starts a new run, however short
 * that stretch was. The final run is left open
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
  // Measured once, from the same rows, before the walk — so every gap test below uses one value.
  const delayOffMs = effectiveDelayOffMs(rows, cfg);
  const boundaries = [...(cfg.boundaryEventsMs ?? [])].sort((a, b) => a - b);
  const hasBoundaryIn = (afterMs: number, throughMs: number): boolean =>
    boundaries.some((b) => b > afterMs && b <= throughMs);

  const periods: DetectedPeriod[] = [];
  let state = false; // latched on/off
  let run: OpenRun | null = null;
  let prevSampleMs: number | null = null; // for midpoint start boundary
  // Has the signal actually been OFF since the last on-sample? The guard that keeps a control edge
  // from splitting a continuously-running engine — see `boundaryEventsMs`.
  let offSinceLastOn = false;

  for (const s of rows) {
    // Gap-close: any sample beyond delayOff from the last on-sample ends the open run.
    if (run && s.tMs - run.lastOnMs > delayOffMs) {
      periods.push(finalize(run, run.lastOnMs, "gap"));
      run = null;
      state = false;
      offSinceLastOn = false;
    }

    if (s.value === null) {
      // Error/missing: counts toward the gap clock (handled above) but is not classified.
      prevSampleMs = s.tMs;
      continue;
    }

    const on = classify(s.value, cfg, state);
    state = on;

    if (on) {
      // Boundary split: the engine stopped and started again inside the anti-flap window, and the
      // control signal moved in that gap — so these are two runs however brief the gap was.
      if (run && offSinceLastOn && hasBoundaryIn(run.lastOnMs, s.tMs)) {
        periods.push(finalize(run, run.lastOnMs, "boundary"));
        run = null;
      }
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
      offSinceLastOn = false;
    } else {
      offSinceLastOn = true;
    }
    // off-sample: leave the run open (delay_off bridging); the gap-close above will end it.
    prevSampleMs = s.tMs;
  }

  // Tail: the final run is open iff its last on-sample is recent; else close it (gap).
  if (run) {
    if (cfg.nowMs - run.lastOnMs <= delayOffMs) {
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
