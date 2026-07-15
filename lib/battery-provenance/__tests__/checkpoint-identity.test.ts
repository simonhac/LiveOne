/**
 * THE Phase-B gate: a fold seeded from a checkpoint reproduces the long fold's tail EXACTLY.
 *
 * Long fold (with midnight snapshots) vs, per snapshot: serialize→validate the envelope (the jsonb
 * round-trip), slice the inputs at the anchor (modeling what the lead-in loader returns for a window
 * starting there), recompute seeded — and assert step-for-step identity with `toEqual` (exact, not
 * closeTo). Variants: SoC-blind (backstop counters carry) and a gap straddling midnight (anchor <
 * midnight). Plus the late-data self-heal property and the validator/midnight helpers.
 */
import { describe, it, expect } from "@jest/globals";
import { computeBatteryProvenance } from "../compute";
import {
  BATPROV_MODEL_VERSION,
  localMidnightsInWindow,
  validateFoldCheckpointEnvelope,
  type FoldCheckpointEnvelope,
} from "../checkpoint";
import type { ProvenanceInputs, ProvenanceResult } from "../types";
import type { FlowSeries } from "../../aggregation/flow-matrix-core";

const SLOT_MS = 300_000;
const DAY_SLOTS = 288;
const TZ = 600;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * A CANONICAL multi-day scenario (persisted param series present, so no in-window learner runs):
 * solar-day charging, evening discharge deep enough to empty the store (reset coverage), an
 * estimated-price stretch, a SoC gap, and (optionally) a mid-day recal snap / SoC-blindness /
 * a timeline gap straddling a midnight.
 */
function scenario(
  opts: {
    days?: number;
    socBlind?: boolean;
    recal?: boolean;
    /** Remove slots straddling the FIRST midnight (gap → anchor < midnight). */
    midnightGap?: boolean;
  } = {},
): ProvenanceInputs {
  const days = opts.days ?? 3;
  const rand = lcg(11);
  // Timeline fence posts start at a local midnight (tz +600).
  const base = Date.parse("2026-01-01T00:00:00Z") - TZ * 60_000;
  const n = days * DAY_SLOTS + 1;
  let timeline = Array.from({ length: n }, (_, i) => base + i * SLOT_MS);

  const solar: number[] = [];
  const gridIn: number[] = [];
  const load: number[] = [];
  const batCharge: number[] = []; // load.battery (kW)
  const batDischarge: number[] = []; // source.battery (kW)
  const soc: (number | null)[] = [];
  const gridEmissions: (number | null)[] = [];
  const gridEmissionsEstimated: boolean[] = [];
  const gridPrice: (number | null)[] = [];

  const capacity = 20;
  let socNow = 40;
  for (let i = 0; i < n; i++) {
    const slot = i % DAY_SLOTS;
    const day = Math.floor(i / DAY_SLOTS);
    const hour = (slot * 5) / 60;
    const sunny = hour >= 8 && hour < 16;
    const evening = hour >= 17 || hour < 5;
    const sol = sunny ? 5 + 2 * rand() : 0;
    const chg = sunny ? 3.5 + rand() : 0;
    // Discharge hard in the evening — deep enough to hit empty (reset) most days.
    const dis = evening ? 3.2 + 0.5 * rand() : 0;
    const ld = 1.2 + 0.3 * rand();
    solar.push(sol);
    gridIn.push(Math.max(0, ld + chg - sol - dis));
    load.push(ld);
    batCharge.push(chg);
    batDischarge.push(dis);
    socNow += (((0.94 * chg - dis) * (SLOT_MS / 3_600_000)) / capacity) * 100;
    socNow = Math.min(97, Math.max(6, socNow));
    if (opts.recal && day === 1 && slot === 100) socNow += 12;
    // SoC gap mid-day 0 (>30 min) — the loader would yield nulls there.
    const socGap = day === 0 && slot >= 60 && slot < 70;
    soc.push(opts.socBlind || socGap ? null : socNow);
    // Estimated stretch: OE feed dark for 2h on day 1.
    const dark = day === 1 && slot >= 140 && slot < 164;
    gridEmissions.push(dark ? null : 550 + 100 * Math.sin(i / 40));
    gridEmissionsEstimated.push(dark);
    gridPrice.push(dark ? null : 25 + 10 * Math.sin(i / 55));
  }

  let drop: (i: number) => boolean = () => false;
  if (opts.midnightGap) {
    // Remove slots ±35 min around the first midnight (posts 281..295 exclusive of the fence ends).
    const m = DAY_SLOTS;
    drop = (i) => i > m - 8 && i < m + 8;
  }
  const keep = timeline.map((_, i) => !drop(i));
  const filt = <T>(a: T[]) => a.filter((_, i) => keep[i]);
  timeline = filt(timeline);

  const sources: FlowSeries[] = [
    { path: "source.solar", power: filt(solar) },
    { path: "source.grid", power: filt(gridIn) },
    { path: "source.battery", power: filt(batDischarge) },
  ];
  const loads: FlowSeries[] = [
    { path: "load", power: filt(load) },
    { path: "load.battery", power: filt(batCharge) },
  ];
  const m = timeline.length;
  const arr = <T>(v: T) => new Array<T>(m).fill(v);
  return {
    handle: 1,
    areaId: "test",
    region: "VIC1",
    batterySystemId: 6,
    timezoneOffsetMin: TZ,
    timeline,
    sources,
    loads,
    gridEmissions: filt(gridEmissions),
    gridEmissionsEstimated: filt(gridEmissionsEstimated),
    gridRenewable: arr<number | null>(0.3),
    gridPrice: filt(gridPrice),
    gridPriceEstimated: filt(gridEmissionsEstimated),
    gridExportPrice: arr<number | null>(6),
    soc: filt(soc),
    estReservePct: 10,
    // CANONICAL persisted param series (daily steps in prod; constants here — window-independent).
    etaSeries: opts.socBlind
      ? arr<number | null>(0.92)
      : arr<number | null>(0.92),
    capacitySeries: opts.socBlind ? undefined : arr<number | null>(capacity),
    chargeEfficiencySeries: opts.socBlind
      ? undefined
      : arr<number | null>(0.94),
    idleLossKwhPerDaySeries: opts.socBlind
      ? undefined
      : arr<number | null>(0.5),
    coverage: { soc: opts.socBlind ? 0 : 1, emissions: 1, price: 1 },
  };
}

/** Model of what the lead-in loader returns for a window starting AT the anchor: every array sliced
 *  from the anchor fence post (the loader's `gte(startMs)` includes it). */
function sliceInputsAt(
  inputs: ProvenanceInputs,
  anchorMs: number,
): ProvenanceInputs {
  const j = inputs.timeline.indexOf(anchorMs);
  if (j < 0) throw new Error("anchor not on the timeline");
  const cut = <T>(a: T[] | undefined): T[] | undefined => a?.slice(j);
  return {
    ...inputs,
    timeline: inputs.timeline.slice(j),
    sources: inputs.sources.map((s) => ({ ...s, power: s.power.slice(j) })),
    loads: inputs.loads.map((l) => ({ ...l, power: l.power.slice(j) })),
    gridEmissions: cut(inputs.gridEmissions)!,
    gridEmissionsEstimated: cut(inputs.gridEmissionsEstimated)!,
    gridRenewable: cut(inputs.gridRenewable)!,
    gridPrice: cut(inputs.gridPrice)!,
    gridPriceEstimated: cut(inputs.gridPriceEstimated)!,
    gridExportPrice: cut(inputs.gridExportPrice)!,
    soc: cut(inputs.soc)!,
    batteryChargeEnergyKwh: cut(inputs.batteryChargeEnergyKwh),
    batteryDischargeEnergyKwh: cut(inputs.batteryDischargeEnergyKwh),
    etaSeries: cut(inputs.etaSeries),
    capacitySeries: cut(inputs.capacitySeries),
    chargeEfficiencySeries: cut(inputs.chargeEfficiencySeries),
    idleLossKwhPerDaySeries: cut(inputs.idleLossKwhPerDaySeries),
  };
}

function runIdentity(inputs: ProvenanceInputs) {
  const start = inputs.timeline[0];
  const end = inputs.timeline[inputs.timeline.length - 1];
  const midnights = localMidnightsInWindow(start, end, TZ);
  expect(midnights.length).toBeGreaterThan(0);

  const long: ProvenanceResult = computeBatteryProvenance(
    inputs,
    {},
    { snapshotAtMs: midnights.map((mm) => mm.midnightMs) },
  );
  expect(long.stateSnapshots).toHaveLength(midnights.length);

  for (const snap of long.stateSnapshots!) {
    // The envelope survives the jsonb round-trip and validates.
    const env0: FoldCheckpointEnvelope = {
      v: BATPROV_MODEL_VERSION,
      midnightMs: snap.requestedMs,
      anchorMs: snap.anchorMs,
      reserveFloorPct: long.reserveUsed,
      etaFallback: long.etaUsed,
      state: snap.state,
    };
    const env = validateFoldCheckpointEnvelope(
      JSON.parse(JSON.stringify(env0)),
    );
    expect(env).not.toBeNull();

    // Seeded recompute over the tail window.
    const tailInputs = sliceInputsAt(inputs, env!.anchorMs);
    const seeded = computeBatteryProvenance(
      tailInputs,
      { reserveFloorPct: env!.reserveFloorPct },
      { initialState: env!.state, efficiencyFallback: env!.etaFallback },
    );

    // steps[i] of the seeded run corresponds to long.steps[anchorIdx + i]
    // (interval i spans timeline[i] → timeline[i+1]).
    const anchorIdx = inputs.timeline.indexOf(env!.anchorMs);
    const expectTail = long.steps.slice(anchorIdx);
    expect(seeded.steps).toEqual(expectTail);
    expect(seeded.finalState).toEqual(long.finalState);
  }
  return { long, midnights };
}

describe("checkpoint-seeded fold ≡ long fold tail (exact)", () => {
  it("canonical cycling battery (resets, estimated stretch, SoC gap)", () => {
    runIdentity(scenario());
  });

  it("with a BMS recal snap", () => {
    runIdentity(scenario({ recal: true }));
  });

  it("SoC-blind battery (backstop counters carried through the seam)", () => {
    runIdentity(scenario({ socBlind: true }));
  });

  it("gap straddling midnight → anchor is BEFORE the midnight and identity still holds", () => {
    const inputs = scenario({ midnightGap: true });
    const { long, midnights } = runIdentity(inputs);
    const firstSnap = long.stateSnapshots![0];
    expect(firstSnap.requestedMs).toBe(midnights[0].midnightMs);
    expect(firstSnap.anchorMs).toBeLessThan(firstSnap.requestedMs);
  });

  it("late intra-day data self-heals: seeded fold over MUTATED today == long fold over mutated history", () => {
    const pristine = scenario();
    const long = computeBatteryProvenance(
      pristine,
      {},
      {
        snapshotAtMs: localMidnightsInWindow(
          pristine.timeline[0],
          pristine.timeline[pristine.timeline.length - 1],
          TZ,
        ).map((mm) => mm.midnightMs),
      },
    );
    const snap = long.stateSnapshots![1]; // start of day 2
    // Mutate an input INSIDE day 2 (after the checkpoint): a price revision at ~10:00.
    const mutate = (inputs: ProvenanceInputs): ProvenanceInputs => {
      const gp = [...inputs.gridPrice];
      const j = inputs.timeline.indexOf(snap.anchorMs) + 120;
      gp[j] = 99;
      return { ...inputs, gridPrice: gp };
    };
    const mutated = mutate(pristine);
    const fullMutated = computeBatteryProvenance(mutated, {});
    const seeded = computeBatteryProvenance(
      sliceInputsAt(mutated, snap.anchorMs),
      { reserveFloorPct: long.reserveUsed },
      { initialState: snap.state, efficiencyFallback: long.etaUsed },
    );
    const anchorIdx = mutated.timeline.indexOf(snap.anchorMs);
    expect(seeded.steps).toEqual(fullMutated.steps.slice(anchorIdx));
  });
});

describe("validateFoldCheckpointEnvelope", () => {
  const goodEnv = (): FoldCheckpointEnvelope => {
    const inputs = scenario({ days: 2 });
    const r = computeBatteryProvenance(
      inputs,
      {},
      {
        snapshotAtMs: localMidnightsInWindow(
          inputs.timeline[0],
          inputs.timeline[inputs.timeline.length - 1],
          TZ,
        ).map((mm) => mm.midnightMs),
      },
    );
    const s = r.stateSnapshots![0];
    return {
      v: BATPROV_MODEL_VERSION,
      midnightMs: s.requestedMs,
      anchorMs: s.anchorMs,
      reserveFloorPct: r.reserveUsed,
      etaFallback: r.etaUsed,
      state: s.state,
    };
  };

  it("accepts a genuine round-tripped envelope", () => {
    expect(
      validateFoldCheckpointEnvelope(JSON.parse(JSON.stringify(goodEnv()))),
    ).not.toBeNull();
  });

  it("rejects NaN/Infinity (the jsonb NaN→null hazard), bad enums, missing keys, anchor>midnight", () => {
    const base = goodEnv();
    expect(
      validateFoldCheckpointEnvelope({
        ...base,
        state: { ...base.state, storedKwh: null },
      }),
    ).toBeNull();
    expect(
      validateFoldCheckpointEnvelope({
        ...base,
        state: { ...base.state, carbonG: Number.POSITIVE_INFINITY },
      }),
    ).toBeNull();
    expect(
      validateFoldCheckpointEnvelope({
        ...base,
        state: { ...base.state, pendingTrigger: "nonsense" },
      }),
    ).toBeNull();
    const { syncEvents: _dropped, ...rest } = base.state;
    expect(validateFoldCheckpointEnvelope({ ...base, state: rest })).toBeNull();
    expect(
      validateFoldCheckpointEnvelope({
        ...base,
        anchorMs: base.midnightMs + 1,
      }),
    ).toBeNull();
    expect(validateFoldCheckpointEnvelope(null)).toBeNull();
    expect(validateFoldCheckpointEnvelope("{}")).toBeNull();
  });

  it("a model-version mismatch is the reader's rejection signal (checked by the loader)", () => {
    const env = JSON.parse(JSON.stringify(goodEnv()));
    env.v = BATPROV_MODEL_VERSION + 1;
    // Validation itself passes (shape is fine) — the LOADER requires v === BATPROV_MODEL_VERSION.
    expect(validateFoldCheckpointEnvelope(env)).not.toBeNull();
    expect(env.v).not.toBe(BATPROV_MODEL_VERSION);
  });
});

describe("localMidnightsInWindow", () => {
  it("emits exactly the midnights strictly after start and ≤ end, with the STARTING day's date", () => {
    // tz +600: local midnight of 2026-01-02 is 2026-01-01T14:00Z.
    const m0 = Date.parse("2026-01-01T14:00:00Z");
    expect(localMidnightsInWindow(m0 - 1, m0, 600)).toEqual([
      { midnightMs: m0, day: "2026-01-02" },
    ]);
    // A midnight exactly AT start is excluded; exactly at end is included.
    expect(localMidnightsInWindow(m0, m0 + 3600_000, 600)).toEqual([]);
    const twoDays = localMidnightsInWindow(m0 - 1, m0 + 86_400_000, 600);
    expect(twoDays.map((m) => m.day)).toEqual(["2026-01-02", "2026-01-03"]);
  });

  it("handles half-hour and negative offsets", () => {
    // tz +570 (Adelaide-ish): local midnight of day d = d*DAY − 570min.
    const m = Date.parse("2026-01-02T00:00:00Z") - 570 * 60_000;
    expect(localMidnightsInWindow(m - 10, m + 10, 570)).toEqual([
      { midnightMs: m, day: "2026-01-02" },
    ]);
    const mNeg = Date.parse("2026-01-02T00:00:00Z") + 300 * 60_000; // tz −300
    expect(localMidnightsInWindow(mNeg - 10, mNeg + 10, -300)).toEqual([
      { midnightMs: mNeg, day: "2026-01-02" },
    ]);
  });

  it("the nightly-heal shape (≈ yesterday 10:00 local → just past midnight) emits exactly today's midnight", () => {
    const todayMidnight = Date.parse("2026-01-01T14:00:00Z"); // local 2026-01-02 00:00 @ +600
    const healStart = todayMidnight - 14 * 3600_000; // yesterday 10:00 local
    const healEnd = todayMidnight + 25 * 60_000; // 00:25 local
    expect(localMidnightsInWindow(healStart, healEnd, 600)).toEqual([
      { midnightMs: todayMidnight, day: "2026-01-02" },
    ]);
  });
});
