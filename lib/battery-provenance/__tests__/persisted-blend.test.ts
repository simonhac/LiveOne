import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * `readPersistedBatteryBlend` replaced a fold in the run-pricing path, and it has exactly two ways of
 * being invisibly wrong: reading each interval one step out (the write stamps step `i` at
 * `timeline[i+1]`, the reader indexes `i`), and forgetting that the two fraction points are persisted
 * as PERCENT. Both produce a plausible series, so both are pinned here.
 */

type Boundish = {
  systemId: number;
  point: string;
  role: string;
  metric: string;
  stem: string | null;
  unit: string | null;
  transform: string | null;
};
type Rowish = {
  intervalEndMs: number;
  avg: number | null;
  dataQuality: string;
};

const boundPointsMock = jest.fn<() => Promise<Boundish[]>>();
const read5mMock = jest.fn<() => Promise<Map<string, Rowish[]>>>();

jest.mock("../load", () => ({
  boundPoints: () => boundPointsMock(),
}));
jest.mock("@/lib/readings", () => ({
  ReadingsDao: { read5m: () => read5mMock() },
}));

import { readPersistedBatteryBlend } from "../persisted-blend";

const T0 = 1_700_000_000_000;
const FIVE_MIN = 5 * 60_000;
/** timeline[0] is a START boundary, never a row: 4 boundaries ⇒ 3 intervals. */
const TIMELINE = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN, T0 + 3 * FIVE_MIN];

const PT = {
  "carbon-intensity": "pt_carbon",
  "renewable-fraction": "pt_renew",
  "self-renewable-fraction": "pt_self",
  price: "pt_price",
  "stored-energy": "pt_stored",
} as const;

function bound(metric: string, stem = "bidi.battery") {
  return {
    systemId: 1,
    point: PT[metric as keyof typeof PT] ?? `pt_${metric}`,
    role: "battery",
    metric,
    stem,
    unit: null,
    transform: null,
  };
}

function row(intervalEndMs: number, avg: number | null, dq = "good") {
  return { intervalEndMs, avg, dataQuality: dq };
}

/** Both DB calls are mocked, so the handle itself is never dereferenced. */
const db = {} as unknown as Parameters<typeof readPersistedBatteryBlend>[0];

beforeEach(() => {
  boundPointsMock.mockReset();
  read5mMock.mockReset();
});

describe("readPersistedBatteryBlend", () => {
  it("aligns row at timeline[i+1] to step i, and undoes the percent scaling", () => {
    boundPointsMock.mockResolvedValue([
      bound("carbon-intensity"),
      bound("renewable-fraction"),
      bound("self-renewable-fraction"),
      bound("price"),
    ]);
    // A DISTINCT value per interval, so an off-by-one cannot hide behind a flat series.
    read5mMock.mockResolvedValue(
      new Map<string, Rowish[]>([
        [
          PT["carbon-intensity"],
          [row(TIMELINE[1], 100), row(TIMELINE[2], 200), row(TIMELINE[3], 300)],
        ],
        [
          PT["renewable-fraction"],
          [row(TIMELINE[1], 94.2), row(TIMELINE[2], 50), row(TIMELINE[3], 0)],
        ],
        [PT["self-renewable-fraction"], [row(TIMELINE[1], 80)]],
        [
          PT.price,
          [row(TIMELINE[1], 0.94), row(TIMELINE[2], 5), row(TIMELINE[3], 9)],
        ],
      ]),
    );

    return readPersistedBatteryBlend(db, "area-1", TIMELINE).then((res) => {
      expect(res).not.toBeNull();
      expect(res!.steps).toHaveLength(TIMELINE.length - 1);
      expect(res!.covered).toBe(3);

      // Step 0 is the row stamped at timeline[1] — NOT timeline[0], which is a boundary with no row.
      expect(res!.steps[0].batteryEmissionsIntensity).toBe(100);
      expect(res!.steps[2].batteryEmissionsIntensity).toBe(300);
      // Percent → fraction.
      expect(res!.steps[0].batteryRenewableFraction).toBeCloseTo(0.942, 9);
      expect(res!.steps[1].batteryRenewableFraction).toBeCloseTo(0.5, 9);
      expect(res!.steps[0].batterySelfRenewableFraction).toBeCloseTo(0.8, 9);
      // Price is native c/kWh — scaling it would be as wrong as not scaling the fractions.
      expect(res!.steps[0].batteryPrice).toBeCloseTo(0.94, 9);
    });
  });

  it("leaves an interval null when the engine has not written it", () => {
    boundPointsMock.mockResolvedValue([bound("carbon-intensity")]);
    read5mMock.mockResolvedValue(
      new Map<string, Rowish[]>([
        // Nothing at TIMELINE[2] — a gap, not a reason to interpolate or carry forward.
        [
          PT["carbon-intensity"],
          [row(TIMELINE[1], 100), row(TIMELINE[3], 300)],
        ],
      ]),
    );
    return readPersistedBatteryBlend(db, "area-1", TIMELINE).then((res) => {
      expect(res!.steps.map((s) => s.batteryEmissionsIntensity)).toEqual([
        100,
        null,
        300,
      ]);
      expect(res!.covered).toBe(2);
    });
  });

  it("carries the estimated flag through as a nonzero fraction", () => {
    boundPointsMock.mockResolvedValue([bound("carbon-intensity")]);
    read5mMock.mockResolvedValue(
      new Map<string, Rowish[]>([
        [
          PT["carbon-intensity"],
          [
            row(TIMELINE[1], 100, "estimated"),
            row(TIMELINE[2], 200, "good"),
            row(TIMELINE[3], 300, "good"),
          ],
        ],
      ]),
    );
    return readPersistedBatteryBlend(db, "area-1", TIMELINE).then((res) => {
      expect(res!.steps.map((s) => s.estimatedFraction)).toEqual([1, 0, 0]);
    });
  });

  it("counts an EMPTY battery as present, not as missing", () => {
    // 🛑 The distinction the run/Sankey gate hangs on. `blendValue` returns null for every intensity
    // when the store is empty — there is no blend to report — but writes `stored-energy` as a real 0.
    // So these intervals are fully computed and a load running through them prices off grid/solar.
    // Reading `covered === 0` as "the engine wrote nothing" would refuse to price them: measured on
    // prod, that would have dropped provenance from 5 real EV sessions.
    boundPointsMock.mockResolvedValue([
      bound("carbon-intensity"),
      bound("stored-energy"),
    ]);
    read5mMock.mockResolvedValue(
      new Map<string, Rowish[]>([
        [
          PT["carbon-intensity"],
          [row(TIMELINE[1], null), row(TIMELINE[2], null)],
        ],
        [PT["stored-energy"], [row(TIMELINE[1], 0), row(TIMELINE[2], 0)]],
      ]),
    );
    return readPersistedBatteryBlend(db, "area-1", TIMELINE).then((res) => {
      expect(res).not.toBeNull();
      expect(res!.covered).toBe(0); // no blend to report…
      expect(res!.present).toBe(2); // …but the engine did compute these intervals
      expect(res!.steps[0].batteryEmissionsIntensity).toBeNull();
    });
  });

  it("returns null when the Area has no blend points bound at all", () => {
    // Distinct from a gap: the caller must refuse to price rather than drop the battery from the
    // blend and report the run at whatever else happened to be running.
    boundPointsMock.mockResolvedValue([
      bound("power"), // the battery's own power point — not a blend point
      bound("carbon-intensity", "bidi.grid"), // right metric, wrong stem
    ]);
    return readPersistedBatteryBlend(db, "area-1", TIMELINE).then((res) => {
      expect(res).toBeNull();
      expect(read5mMock).not.toHaveBeenCalled();
    });
  });

  it("returns null for a timeline too short to have an interval", () => {
    boundPointsMock.mockResolvedValue([bound("carbon-intensity")]);
    return readPersistedBatteryBlend(db, "area-1", [T0]).then((res) => {
      expect(res).toBeNull();
    });
  });
});
