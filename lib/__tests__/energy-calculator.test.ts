import { describe, expect, it } from "@jest/globals";
import { calculateSeriesEnergy } from "@/lib/energy-calculator";

const DAY_MS = 24 * 60 * 60_000;

const days = (n: number, from = "2026-03-01") =>
  Array.from(
    { length: n },
    (_, i) => new Date(new Date(`${from}T00:00:00Z`).getTime() + i * DAY_MS),
  );

describe("calculateSeriesEnergy", () => {
  it("energy mode is a plain sum of the buckets", () => {
    const out = calculateSeriesEnergy(
      [{ id: "a", data: [1, 2, 3] }],
      days(3),
      "energy",
    );
    expect(out.get("a")).toBe(6);
  });

  it("energy mode skips nulls, and returns null when every bucket is a gap", () => {
    const ts = days(3);
    expect(
      calculateSeriesEnergy(
        [{ id: "a", data: [1, null, 3] }],
        ts,
        "energy",
      ).get("a"),
    ).toBe(4);
    expect(
      calculateSeriesEnergy(
        [{ id: "a", data: [null, null, null] }],
        ts,
        "energy",
      ).get("a"),
    ).toBeNull();
  });

  it("energy mode totals a single bucket — a one-month Y window is not 'no data'", () => {
    // The old heuristic path required ≥2 points to return anything at all, which at one bar per
    // month is a window the legend table could plausibly be showing.
    expect(
      calculateSeriesEnergy([{ id: "a", data: [42] }], days(1), "energy").get(
        "a",
      ),
    ).toBe(42);
  });

  it("the M total is unchanged by the unit fix: sum(kWh/day) === old sum(kW×24)", () => {
    // The regression check for the ×24 move. Daily average POWER, as the API returns it…
    const dailyKw = [1, 2.5, 0, 4, 3.25, null, 2];
    const ts = days(dailyKw.length);
    // …the total this function used to produce, via its `isDailyData` branch.
    const legacyTotal = dailyKw.reduce<number>((s, v) => s + (v ?? 0) * 24, 0);
    // …and what it produces now, from the values `toDailyEnergy` hands it.
    const asEnergy = dailyKw.map((v) => (v === null ? null : v * 24));
    expect(
      calculateSeriesEnergy([{ id: "a", data: asEnergy }], ts, "energy").get(
        "a",
      ),
    ).toBeCloseTo(legacyTotal, 9);
  });

  it("the Y total equals the M total: rolling days into months loses nothing", () => {
    const asEnergy = Array.from({ length: 62 }, (_, i) => i + 1);
    const daily = calculateSeriesEnergy(
      [{ id: "a", data: asEnergy }],
      days(62, "2026-07-01"),
      "energy",
    ).get("a")!;
    // July's 31 days folded into one bar, August's into another.
    const july = asEnergy.slice(0, 31).reduce((s, v) => s + v, 0);
    const august = asEnergy.slice(31).reduce((s, v) => s + v, 0);
    const monthly = calculateSeriesEnergy(
      [{ id: "a", data: [july, august] }],
      days(2, "2026-07-01"),
      "energy",
    ).get("a")!;
    expect(monthly).toBe(daily);
  });

  it("power mode integrates trapezoidally over the timestamps", () => {
    const ts = [
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-01T01:00:00Z"),
      new Date("2026-03-01T02:00:00Z"),
    ];
    // (2+4)/2·1h + (4+6)/2·1h = 3 + 5
    expect(
      calculateSeriesEnergy([{ id: "a", data: [2, 4, 6] }], ts, "power").get(
        "a",
      ),
    ).toBeCloseTo(8, 9);
  });

  it("power mode drops a segment with a null endpoint rather than treating it as zero", () => {
    const ts = [
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-03-01T01:00:00Z"),
      new Date("2026-03-01T02:00:00Z"),
    ];
    expect(
      calculateSeriesEnergy([{ id: "a", data: [2, null, 6] }], ts, "power").get(
        "a",
      ),
    ).toBeNull();
  });

  it("returns null for an empty series, in either mode", () => {
    expect(
      calculateSeriesEnergy([{ id: "a", data: [] }], [], "energy").get("a"),
    ).toBeNull();
    expect(
      calculateSeriesEnergy([{ id: "a", data: [] }], [], "power").get("a"),
    ).toBeNull();
  });
});
