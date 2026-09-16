/**
 * The PG loader's ONE piece of domain knowledge: which interval each energy register's readings
 * cover.
 *
 * `attachEnergyOverlays` refuses a reading that does not cover its destination interval, but only
 * because the loader tells it how long a reading lasts. That wiring — vendor → `agg5mIntervalMs` →
 * `EnergySeriesInput.intervalMs`, resolved PER POINT — has no other test: the pure overlay tests
 * hand `intervalMs` in by hand, so deleting or mis-assigning it here would leave every one of them
 * green while a half-hourly Amber reading went back to being booked as five minutes of energy.
 *
 * Resolution is per point and not per bundle because a multi-device area mixes vendors — Kinkora Rd
 * takes its grid registers from Amber (half-hourly) and everything else from Mondo (five-minutely).
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: {} }));
jest.mock("@/lib/readings", () => ({ ReadingsDao: { read5m: jest.fn() } }));
jest.mock("@/lib/registry/device-config", () => ({
  DeviceConfigRegistry: { deviceByHandle: jest.fn() },
}));

import { loadFlowSeriesFromAgg5m } from "../flow-series-pg";
import { ReadingsDao } from "@/lib/readings";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

const read5m = jest.mocked(ReadingsDao.read5m);
const deviceByHandle = jest.mocked(DeviceConfigRegistry.deviceByHandle);

const FIVE = 300_000;
/** 13 stamps → 12 five-minute intervals, starting at FIVE. */
const STAMPS = Array.from({ length: 13 }, (_, i) => (i + 1) * FIVE);

/** Device 5 = Mondo (5-minute), device 9 = Amber (half-hourly) — the Kinkora Rd shape. */
const VENDOR_BY_RID: Record<number, string> = { 5: "mondo", 9: "amber" };

const pt = (id: string, systemId: number, pointId: number, stem: string) => ({
  point: id as never,
  ref: { systemId, pointId },
  stem,
  metricUnit: "W",
  transform: null,
});

describe("loadFlowSeriesFromAgg5m: per-point register duration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deviceByHandle.mockImplementation((async (rid: number) =>
      VENDOR_BY_RID[rid]
        ? ({ vendorType: VENDOR_BY_RID[rid] } as never)
        : null) as never);
  });

  /** Steady −1.2 kW grid (export) and 1.2 kW solar on every stamp, from Mondo. */
  const powerRows = () =>
    new Map<unknown, unknown>([
      [
        "p-solar",
        STAMPS.map((t) => ({ intervalEndMs: t, avg: 1200, delta: null })),
      ],
      [
        "p-grid",
        STAMPS.map((t) => ({ intervalEndMs: t, avg: -1200, delta: null })),
      ],
    ]);

  it("gives an Amber register its 30-minute duration → the coarse reading is refused", () => {
    const rows = powerRows();
    // Amber's half-hourly export register: 0.6 kWh (600 Wh) stamped twice.
    rows.set(
      "p-amber-export",
      [STAMPS[6], STAMPS[12]].map((t) => ({
        intervalEndMs: t,
        avg: null,
        delta: 600,
      })),
    );
    read5m.mockResolvedValue(rows as never);

    return loadFlowSeriesFromAgg5m(
      {} as never,
      [pt("p-solar", 5, 1, "source.solar"), pt("p-grid", 5, 2, "bidi.grid")],
      STAMPS[0],
      STAMPS[12],
      [{ ...pt("p-amber-export", 9, 3, "bidi.grid.export"), metricUnit: "Wh" }],
    ).then((b) => {
      const grid = b.loads.find((l) => l.path === "load.grid");
      // Refused ⇒ every interval unknown, so the node integrates its power series instead.
      expect(grid!.energyKwh).toEqual(new Array(12).fill(null));
      expect(deviceByHandle).toHaveBeenCalledWith(9);
    });
  });

  it("gives a five-minute vendor's register the nominal duration → it is kept", () => {
    const rows = powerRows();
    // The same node, metered by the 5-minute vendor: 0.1 kWh (100 Wh) every stamp.
    rows.set(
      "p-mondo-export",
      STAMPS.map((t) => ({ intervalEndMs: t, avg: null, delta: 100 })),
    );
    read5m.mockResolvedValue(rows as never);

    return loadFlowSeriesFromAgg5m(
      {} as never,
      [pt("p-solar", 5, 1, "source.solar"), pt("p-grid", 5, 2, "bidi.grid")],
      STAMPS[0],
      STAMPS[12],
      [{ ...pt("p-mondo-export", 5, 4, "bidi.grid.export"), metricUnit: "Wh" }],
    ).then((b) => {
      const grid = b.loads.find((l) => l.path === "load.grid");
      expect(grid!.energyKwh).toEqual(new Array(12).fill(0.1));
    });
  });

  it("resolves the duration per POINT, not once for the bundle", () => {
    // Both registers at once, from different vendors: the Amber one is refused and the Mondo one
    // survives. One shared `intervalMs` for the bundle could not produce this.
    const rows = powerRows();
    rows.set(
      "p-amber-export",
      [STAMPS[6], STAMPS[12]].map((t) => ({
        intervalEndMs: t,
        avg: null,
        delta: 600,
      })),
    );
    rows.set(
      "p-mondo-battery",
      STAMPS.map((t) => ({ intervalEndMs: t, avg: null, delta: 50 })),
    );
    // An overlay only DECORATES a node a power point created, so the battery needs one. Negative =
    // charging, which is the `load.battery` half.
    rows.set(
      "p-battery",
      STAMPS.map((t) => ({ intervalEndMs: t, avg: -600, delta: null })),
    );
    read5m.mockResolvedValue(rows as never);

    return loadFlowSeriesFromAgg5m(
      {} as never,
      [
        pt("p-solar", 5, 1, "source.solar"),
        pt("p-grid", 5, 2, "bidi.grid"),
        pt("p-battery", 5, 6, "bidi.battery"),
      ],
      STAMPS[0],
      STAMPS[12],
      [
        { ...pt("p-amber-export", 9, 3, "bidi.grid.export"), metricUnit: "Wh" },
        {
          ...pt("p-mondo-battery", 5, 5, "bidi.battery.charge"),
          metricUnit: "Wh",
        },
      ],
    ).then((b) => {
      expect(b.loads.find((l) => l.path === "load.grid")!.energyKwh).toEqual(
        new Array(12).fill(null),
      );
      expect(b.loads.find((l) => l.path === "load.battery")!.energyKwh).toEqual(
        new Array(12).fill(0.05),
      );
    });
  });
});
