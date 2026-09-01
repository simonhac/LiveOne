/**
 * Per-role detector defaults — the behaviour knobs a run-detector `derivations` row inherits for
 * any key absent from its sparse `params`. The threshold bounds (lower/upper) have no sensible
 * default and are always per-instance; these cover the anti-flap / boundary behaviour only.
 *
 * Generator defaults reproduce the legacy generator-events behaviour (120s coalescing, no
 * hysteresis, edge boundaries, no min-run) so the cutover is observable as "same events, now
 * bounded and persisted".
 *
 * These are BEHAVIOUR knobs, not thresholds, so they are per-ROLE rather than per-signal: every
 * generator run looks like a generator run regardless of which point is watched. Only `boundaryMode`
 * is code-only; the rest can be overridden per detector in its own sparse `params` (see
 * lib/derivations/resolve.ts).
 *
 * 🛑 `delayOffMs` HERE IS THE MERGE POLICY ONLY — how long a genuine pause may be before two runs
 * are separate. It is NOT the gap tolerance, even though it is compared against a sample gap.
 * Tolerating a late or dropped poll is a function of the signal's CADENCE, which no per-role
 * constant can know: this file said "a detector whose signal has an unusual cadence overrides the
 * delays in its own params", and relying on whoever creates the detector to notice is exactly how
 * the Kutis EV detector shipped at 1.0x its cadence and reported one six-hour charge as 25 runs.
 * `detect.ts` now floors the value at `k x` the observed on-sample cadence
 * (`DetectConfig.delayOffCadenceMultiple`), so these numbers only have to answer the policy
 * question — which is the only one a role can answer.
 */

export interface DetectorDefaults {
  hysteresisW: number;
  delayOnMs: number;
  delayOffMs: number;
  boundaryMode: "edge" | "midpoint";
}

const SECOND = 1000;

const GENERATOR_DEFAULTS: DetectorDefaults = {
  hysteresisW: 0,
  delayOnMs: 0,
  delayOffMs: 120 * SECOND,
  boundaryMode: "edge",
};

/**
 * EV charging. Sized against the Kinkora Mondo EV circuit (`load.ev/power`), measured over 30 days:
 * 19,492 samples at a 120 s median cadence (p95 123 s, max 184 s), 18,011 of them at exactly 0 and
 * 1,477 above 100 W — only FOUR samples land in the 1–100 W band. So the signal is genuinely
 * bimodal, and none of these knobs is doing threshold work:
 *
 *  - `hysteresisW: 0` — there is no flapping band to damp. A deadband here would only widen the
 *    window in which the latch holds a stale state.
 *  - `delayOffMs` 300 s bounds how close two sessions can be before they merge — an unplug/replug
 *    inside five minutes reads as one session, which is the right call for a charge session. That
 *    MERGE decision is all this number now carries. It happens also to sit at 2.5x Kinkora's 120 s
 *    cadence, which is why it worked here and why nothing noticed it was doing a second job; on a
 *    300 s-cadence signal the same figure is 1.0x and detects nothing but fragments. The cadence
 *    floor in `detect.ts` owns that half now.
 *  - `delayOnMs: 0` — at this cadence a single on-sample is a real two-minute charging observation,
 *    not a spike, so there is nothing to drop.
 *  - `boundaryMode: "midpoint"` — the one deviation from the generator. It matters BECAUSE
 *    `delayOnMs` is 0: with `edge` boundaries a single-sample run spans zero seconds, and
 *    `assignEnergyToPeriods` needs a window wide enough to hold two counter readings before it can
 *    report any energy at all (fewer than two ⇒ null). Midpoint also removes the systematic
 *    half-interval late start that `edge` gives every run.
 */
const EV_DEFAULTS: DetectorDefaults = {
  hysteresisW: 0,
  delayOnMs: 0,
  delayOffMs: 300 * SECOND,
  boundaryMode: "midpoint",
};

/** Fallback for any role without explicit defaults (e.g. a future pump). */
const GENERIC_DEFAULTS: DetectorDefaults = {
  hysteresisW: 0,
  delayOnMs: 30 * SECOND,
  delayOffMs: 120 * SECOND,
  boundaryMode: "edge",
};

const DEFAULTS_BY_ROLE: Record<string, DetectorDefaults> = {
  generator: GENERATOR_DEFAULTS,
  ev: EV_DEFAULTS,
};

export function detectorDefaultsForRole(role: string): DetectorDefaults {
  return DEFAULTS_BY_ROLE[role] ?? GENERIC_DEFAULTS;
}
