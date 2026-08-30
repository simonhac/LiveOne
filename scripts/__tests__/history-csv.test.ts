import { describe, it, expect } from "@jest/globals";
import { historyCsv, toCsv } from "../ops/shared";

/** A minimal wire series in the shape /api/history serves. */
const series = (
  id: string,
  units: string | undefined,
  firstInterval: string,
  interval: string,
  data: (number | string | null)[],
) => ({ id, units, history: { firstInterval, interval, data } });

describe("historyCsv", () => {
  it("is WIDE: one row per timestamp, one unit-labelled column per series", () => {
    const body = {
      data: [
        series(
          "13/load/power.avg",
          "W",
          "2026-08-30T00:00:00+10:00",
          "5m",
          [412, 390],
        ),
        series(
          "13/bidi.battery/power.avg",
          "W",
          "2026-08-30T00:00:00+10:00",
          "5m",
          [-1300, -1250],
        ),
      ],
    };
    expect(historyCsv(body)).toBe(
      [
        "timestamp_local,timestamp_utc,13/load/power.avg (W),13/bidi.battery/power.avg (W)",
        "2026-08-30T00:00:00+10:00,2026-08-29T14:00:00Z,412,-1300",
        "2026-08-30T00:05:00+10:00,2026-08-29T14:05:00Z,390,-1250",
        "",
      ].join("\n"),
    );
  });

  it("emits nulls as empty cells and quality strings verbatim", () => {
    const body = {
      data: [
        series(
          "13/load/energy.delta",
          "kWh",
          "2026-08-30T00:00:00+10:00",
          "30m",
          [0.5, null],
        ),
        series(
          "13/load/energy.quality",
          undefined,
          "2026-08-30T00:00:00+10:00",
          "30m",
          ["a", "e"],
        ),
      ],
    };
    // A unit-less series gets a bare id header — no dangling "()".
    expect(historyCsv(body)).toBe(
      [
        "timestamp_local,timestamp_utc,13/load/energy.delta (kWh),13/load/energy.quality",
        "2026-08-30T00:00:00+10:00,2026-08-29T14:00:00Z,0.5,a",
        "2026-08-30T00:30:00+10:00,2026-08-29T14:30:00Z,,e",
        "",
      ].join("\n"),
    );
  });

  it("unions divergent grids by epoch rather than misaligning columns", () => {
    // The short series covers only the second timestamp; its first cell must be empty, and the
    // timestamps must be the union of both grids.
    const body = {
      data: [
        series(
          "13/a/power.avg",
          "W",
          "2026-08-30T00:00:00+10:00",
          "5m",
          [1, 2],
        ),
        series("13/b/power.avg", "W", "2026-08-30T00:05:00+10:00", "5m", [9]),
      ],
    };
    expect(historyCsv(body)).toBe(
      [
        "timestamp_local,timestamp_utc,13/a/power.avg (W),13/b/power.avg (W)",
        "2026-08-30T00:00:00+10:00,2026-08-29T14:00:00Z,1,",
        "2026-08-30T00:05:00+10:00,2026-08-29T14:05:00Z,2,9",
        "",
      ].join("\n"),
    );
  });

  it("steps 1d series by whole days at the subject's fixed offset", () => {
    const body = {
      data: [
        series(
          "13/load/energy.delta",
          "kWh",
          "2026-07-01T00:00:00+09:30",
          "1d",
          [10.5, 11],
        ),
      ],
    };
    expect(historyCsv(body)).toBe(
      [
        "timestamp_local,timestamp_utc,13/load/energy.delta (kWh)",
        "2026-07-01T00:00:00+09:30,2026-06-30T14:30:00Z,10.5",
        "2026-07-02T00:00:00+09:30,2026-07-01T14:30:00Z,11",
        "",
      ].join("\n"),
    );
  });

  it("renders an empty body as a bare header", () => {
    expect(historyCsv({ data: [] })).toBe("timestamp_local,timestamp_utc\n");
  });
});

describe("toCsv", () => {
  it("quotes only when needed and renders null/undefined as empty", () => {
    expect(
      toCsv(
        ["a", "b (W)"],
        [
          [1, null],
          ['say "hi", ok', undefined],
        ],
      ),
    ).toBe('a,b (W)\n1,\n"say ""hi"", ok",\n');
  });
});
