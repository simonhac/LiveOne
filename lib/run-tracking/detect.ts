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
   * Once there has been no on-sample for delayOffMs the run is closed at (or just after, under a
   * `midpoint` {@link boundaryMode}) its last on-sample; this also decides whether the final run is
   * left open (running now). Folds in "staleness".
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
   * Boundary assignment. "edge" (default) uses the first/last on-sample verbatim.
   *
   * "midpoint" places EACH boundary midway between the run's outermost on-sample and the
   * neighbouring sample outside it: the start midway between the previous sample and the first
   * on-sample, the end midway between the last on-sample and the next sample. A device seen on at
   * `t` and off at `t + c` switched somewhere in between, and the midpoint is the unbiased estimate
   * of where — so a run of `n` on-samples spans `n × cadence`, which is exactly the span the flow
   * matrix integrates its energy over.
   *
   * 🛑 IT MUST BE BOTH ENDS. Until 2026-09 the midpoint was applied to the START only and the end
   * fell back to the last on-sample, so every run spanned `(n − 0.5) × cadence` and
   * {@link allocatePowerToWindows} integrated half a sample interval less energy than the Sankey
   * band above it — a flat 0.283 kWh per run on the Kutis charger (6.86 kW, 300 s cadence), which
   * is 11% of a 22-minute session. It read as a rounding difference and was not: it was a fixed
   * debt per run, so it grew with the number of sessions, not with their length.
   *
   * Each extension is CAPPED at half the observed on-sample cadence ({@link
   * medianOnSampleIntervalMs}). Without the cap a run adjacent to a data gap has its boundary
   * dragged half the gap — and `signalIntegrator` reconstructs a STEP there, holding the run's own
   * power flat across it, so a three-hour gap manufactures ~10 kWh of charging that never happened.
   * When polls are on time the cap is not reached (`min(c/2, c/2)`), so this changes nothing in the
   * ordinary case. With no measurable cadence (< 4 on-intervals) the uncapped midpoint stands.
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

type CloseReason = "gap" | "boundary" | null;

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
  /**
   * This run began without the device ever having been SEEN off since the previous run ended — so
   * the split between them came from missing data, not from the device stopping.
   *
   * 🛑 THE SIGNAL FRAGMENTATION HAS OTHERWISE GOT NONE, and `closeReason` is not it: an off-sample
   * does not close a run (it is bridged, and the gap clock ends the run later), so EVERY closed run
   * reads "gap" and the field is a constant. The two cases are genuinely indistinguishable from the
   * run rows alone — a device that stopped and a poll that was late both yield two runs — which is
   * why 408 three-minute fragments and 27 real charge sessions looked like the same kind of answer.
   *
   * What separates them is what sits BETWEEN the runs. A device that really stopped leaves samples
   * below the threshold; a late poll leaves nothing at all, because absence is what made the gap.
   * A `null` sample counts as absence too — "missing" is not evidence the device was off.
   *
   * False for the first run of a window (nothing precedes it) and after a boundary split (which
   * requires an off-sample by construction).
   */
  precededByDataGap: boolean;
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
  return delayOffFromCadence(medianOnSampleIntervalMs(samples, cfg), cfg);
}

/**
 * {@link effectiveDelayOffMs} with the cadence already in hand. Split out because the walk needs
 * the same cadence for the boundary cap, and measuring it twice invites the two answers to drift.
 */
function delayOffFromCadence(
  cadenceMs: number | null,
  cfg: DetectConfig,
): number {
  const k = cfg.delayOffCadenceMultiple ?? DEFAULT_DELAY_OFF_CADENCE_MULTIPLE;
  if (k <= 0) return cfg.delayOffMs;
  return cadenceMs === null
    ? cfg.delayOffMs
    : Math.max(cfg.delayOffMs, cadenceMs * k);
}

interface OpenRun {
  precededByDataGap: boolean;
  startMs: number;
  firstOnMs: number;
  lastOnMs: number;
  /**
   * The first sample of ANY kind (off, or null/missing) strictly after `lastOnMs`, or null while
   * the last thing seen was the on-sample itself. The mirror of the walk's `prevSampleMs`, which
   * likewise counts nulls — a missing reading is still evidence of WHEN the next observation
   * happened, which is all the midpoint needs. Reset every time `lastOnMs` advances.
   */
  nextSampleAfterLastOnMs: number | null;
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
    precededByDataGap: run.precededByDataGap,
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
 * off, or null) arriving more than `delayOffMs` after the last on-sample closes the run on that
 * last on-sample; an on-sample beyond the gap starts a new run. An on-sample that resumes after an
 * OFF stretch containing a control edge (`boundaryEventsMs`) also starts a new run, however short
 * that stretch was. The final run is left open
 * (endMs = null) iff `now − lastOn ≤ delayOffMs`. Closed runs shorter than `delayOnMs` are
 * dropped (the open run is exempt). Metrics are over the raw on-sample values.
 *
 * Where the reported boundaries sit relative to those on-samples is {@link
 * DetectConfig.boundaryMode} — and under `midpoint` a closed run extends past its last on-sample,
 * so `endMs` is NOT in general the timestamp of any sample.
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
  // Measured once, from the same rows, before the walk — so every gap test below uses one value,
  // and the boundary cap and the gap floor cannot disagree about what the cadence is.
  const cadenceMs = medianOnSampleIntervalMs(rows, cfg);
  const delayOffMs = delayOffFromCadence(cadenceMs, cfg);
  // How far a `midpoint` boundary may reach past the outermost on-sample: half the way to the
  // neighbouring sample, but never more than half a cadence. See `DetectConfig.boundaryMode`.
  const halfCadenceMs = cadenceMs === null ? null : cadenceMs / 2;
  const extendMs = (gapMs: number): number =>
    halfCadenceMs === null ? gapMs / 2 : Math.min(gapMs / 2, halfCadenceMs);
  // The one place a closed run's end is decided — three call sites close runs, and letting each
  // spell it out is how the end came to disagree with the start in the first place.
  const closeAt = (run: OpenRun): number =>
    midpoint && run.nextSampleAfterLastOnMs != null
      ? run.lastOnMs + extendMs(run.nextSampleAfterLastOnMs - run.lastOnMs)
      : run.lastOnMs;
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
  // The same question, but NOT reset when a run closes — which is the whole difference. Read at the
  // moment a run opens, it answers "was the device seen off between that run and this one?", and a
  // "no" means the two were split by absent data rather than by the device stopping.
  // See `DetectedPeriod.precededByDataGap`.
  let offSeenSinceLastOnSample = false;
  let aRunHasClosed = false;

  for (const s of rows) {
    // Gap-close: any sample beyond delayOff from the last on-sample ends the open run.
    if (run && s.tMs - run.lastOnMs > delayOffMs) {
      periods.push(finalize(run, closeAt(run), "gap"));
      run = null;
      state = false;
      offSinceLastOn = false;
      aRunHasClosed = true;
    }

    if (s.value === null) {
      // Error/missing: counts toward the gap clock (handled above) but is not classified. It still
      // dates the next observation, so it can bound a midpoint end exactly as an off-sample does.
      if (run && run.nextSampleAfterLastOnMs === null)
        run.nextSampleAfterLastOnMs = s.tMs;
      prevSampleMs = s.tMs;
      continue;
    }

    const on = classify(s.value, cfg, state);
    state = on;

    if (on) {
      // Boundary split: the engine stopped and started again inside the anti-flap window, and the
      // control signal moved in that gap — so these are two runs however brief the gap was.
      if (run && offSinceLastOn && hasBoundaryIn(run.lastOnMs, s.tMs)) {
        periods.push(finalize(run, closeAt(run), "boundary"));
        run = null;
        aRunHasClosed = true;
      }
      if (!run) {
        const startMs =
          midpoint && prevSampleMs != null
            ? s.tMs - extendMs(s.tMs - prevSampleMs)
            : s.tMs;
        run = {
          // Read BEFORE the flag is cleared below, and only meaningful once something has closed.
          precededByDataGap: aRunHasClosed && !offSeenSinceLastOnSample,
          startMs,
          firstOnMs: s.tMs,
          lastOnMs: s.tMs,
          nextSampleAfterLastOnMs: null,
          count: 1,
          sum: s.value,
          max: s.value,
          min: s.value,
        };
      } else {
        run.lastOnMs = s.tMs;
        // The run reaches past this sample now, so whatever off/null samples it bridged are no
        // longer the thing that follows it.
        run.nextSampleAfterLastOnMs = null;
        run.count += 1;
        run.sum += s.value;
        if (s.value > run.max) run.max = s.value;
        if (s.value < run.min) run.min = s.value;
      }
      offSinceLastOn = false;
      offSeenSinceLastOnSample = false;
    } else {
      if (run && run.nextSampleAfterLastOnMs === null)
        run.nextSampleAfterLastOnMs = s.tMs;
      offSinceLastOn = true;
      offSeenSinceLastOnSample = true;
    }
    // off-sample: leave the run open (delay_off bridging); the gap-close above will end it.
    prevSampleMs = s.tMs;
  }

  // Tail: the final run is open iff its last on-sample is recent; else close it (gap).
  if (run) {
    if (cfg.nowMs - run.lastOnMs <= delayOffMs) {
      periods.push(finalize(run, null, null));
    } else {
      periods.push(finalize(run, closeAt(run), "gap"));
    }
  }

  // delay_on: drop short closed runs; never drop the open one.
  return periods.filter(
    (p) => p.endMs === null || p.endMs - p.startMs >= cfg.delayOnMs,
  );
}
