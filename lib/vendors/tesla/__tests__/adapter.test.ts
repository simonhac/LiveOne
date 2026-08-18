import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { FetchContext, FetchResult } from "@/lib/vendors/types";

// Keep the base-adapter import chain inert (no DB at import time).
jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: null,
  requirePlanetscaleDb: () => ({}),
}));

const mockClient = {
  getVehicles: jest.fn<(token: string) => Promise<any[]>>(),
  wakeUp: jest.fn<(token: string, vehicleId: string) => Promise<boolean>>(),
  getVehicleData: jest.fn<(token: string, vehicleId: string) => Promise<any>>(),
};

jest.mock("@/lib/vendors/tesla/tesla-client", () => ({
  getTeslaClient: () => mockClient,
}));

jest.mock("@/lib/vendors/tesla/tesla-auth", () => ({
  getValidTeslaToken: jest.fn(async () => ({
    accessToken: "tok",
    credentials: {
      vehicle_id: "12345",
      fleet_api_base_url: "https://fleet.test",
    },
  })),
}));

// Imported after the mocks so the adapter picks them up.
import { TeslaAdapter, resolveTeslaConfig } from "../adapter";

class TestableTeslaAdapter extends TeslaAdapter {
  fetch(device: DeviceConfigView, ctx: FetchContext): Promise<FetchResult> {
    return this.fetchData(device, {}, ctx);
  }
  interval(device: DeviceConfigView): number {
    return this.intervalFor(device);
  }
  setChargingFlag(deviceId: number, value: boolean): void {
    (
      this as unknown as { chargingStates: Map<number, boolean> }
    ).chargingStates.set(deviceId, value);
  }
  getChargingFlag(deviceId: number): boolean | undefined {
    return (
      this as unknown as { chargingStates: Map<number, boolean> }
    ).chargingStates.get(deviceId);
  }
}

function makeDevice(metadata: unknown = null): DeviceConfigView {
  return {
    id: 10,
    displayName: "Tez",
    ownerClerkUserId: "user_x",
    metadata,
    timezoneOffsetMin: 600,
    pollingStatus: null,
  } as unknown as DeviceConfigView;
}

const startedAt = new Date("2026-08-03T00:03:30Z");
const context: FetchContext = {
  startedAt,
  dryRun: false,
  session: { id: "s1", started: startedAt },
};

function vehicleData(chargingState: string) {
  return {
    charge_state: {
      battery_level: 62,
      charge_limit_soc: 80,
      charging_state: chargingState,
      charge_port_latch: "Engaged",
    },
  };
}

let adapter: TestableTeslaAdapter;

beforeEach(() => {
  adapter = new TestableTeslaAdapter();
  mockClient.getVehicles.mockReset();
  mockClient.wakeUp.mockReset();
  mockClient.getVehicleData.mockReset();
});

describe("TeslaAdapter.fetchData", () => {
  it("1. plain path is unchanged when no charging flag is set", async () => {
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "online" }]);
    mockClient.getVehicleData.mockResolvedValue(vehicleData("Charging"));

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(true);
    expect(result.readings?.length).toBeGreaterThan(0);
    expect(mockClient.getVehicles).toHaveBeenCalledTimes(1);
    expect(mockClient.getVehicleData).toHaveBeenCalledTimes(1);
    expect(mockClient.getVehicles.mock.invocationCallOrder[0]).toBeLessThan(
      mockClient.getVehicleData.mock.invocationCallOrder[0],
    );
    expect(adapter.getChargingFlag(10)).toBe(true);
  });

  it("2. skips getVehicles when the previous poll reported charging", async () => {
    // Prime the flag through the real flow.
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "online" }]);
    mockClient.getVehicleData.mockResolvedValue(vehicleData("Charging"));
    await adapter.fetch(makeDevice(), context);

    mockClient.getVehicles.mockClear();
    mockClient.getVehicleData.mockClear();

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(true);
    expect(mockClient.getVehicles).not.toHaveBeenCalled();
    expect(mockClient.getVehicleData).toHaveBeenCalledTimes(1);
    expect(result.rawResponse).toEqual(vehicleData("Charging"));
    expect(adapter.getChargingFlag(10)).toBe(true);
  });

  it("3. falls back to a skipped poll when the car is asleep and wakeToPoll is off", async () => {
    adapter.setChargingFlag(10, true);
    mockClient.getVehicleData.mockRejectedValue(
      new Error("Failed to fetch vehicle data: 408"),
    );
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "asleep" }]);

    const device = makeDevice({ tesla: { wakeToPoll: false } });
    const result = await adapter.fetch(device, context);

    expect(result.success).toBe(true);
    expect(result.readings).toEqual([]);
    expect(result.rawResponse).toEqual({
      skipped: true,
      reason: "Vehicle asleep, wakeToPoll disabled",
    });
    expect(mockClient.wakeUp).not.toHaveBeenCalled();
    expect(adapter.getChargingFlag(10)).toBe(false);

    // The cadence drops back to idle.
    expect(adapter.interval(device)).toBe(15);
  });

  it("4. falls back to the wake path and succeeds when the car wakes", async () => {
    adapter.setChargingFlag(10, true);
    mockClient.getVehicleData
      .mockRejectedValueOnce(new Error("Failed to fetch vehicle data: 408"))
      .mockResolvedValue(vehicleData("Charging"));
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "asleep" }]);
    mockClient.wakeUp.mockResolvedValue(true);

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(true);
    expect(result.readings?.length).toBeGreaterThan(0);
    expect(mockClient.getVehicleData).toHaveBeenCalledTimes(2);
    expect(adapter.getChargingFlag(10)).toBe(true);
  });

  it("5. records a skipped poll when the wake fails", async () => {
    adapter.setChargingFlag(10, true);
    mockClient.getVehicleData.mockRejectedValue(
      new Error("Failed to fetch vehicle data: 408"),
    );
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "asleep" }]);
    mockClient.wakeUp.mockResolvedValue(false);

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(true);
    expect(result.readings).toEqual([]);
    expect(result.rawResponse).toEqual({
      skipped: true,
      reason: "Vehicle did not wake up",
    });
    expect(adapter.getChargingFlag(10)).toBe(false);
  });

  it("6. retries via the presence check after a transient error while genuinely online", async () => {
    adapter.setChargingFlag(10, true);
    mockClient.getVehicleData
      .mockRejectedValueOnce(new Error("Failed to fetch vehicle data: 500"))
      .mockResolvedValue(vehicleData("Charging"));
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "online" }]);

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(true);
    expect(result.readings?.length).toBeGreaterThan(0);
    expect(mockClient.wakeUp).not.toHaveBeenCalled();
    expect(adapter.getChargingFlag(10)).toBe(true);
  });

  it("7. fails and clears the flag when the vehicle is gone", async () => {
    adapter.setChargingFlag(10, true);
    mockClient.getVehicleData.mockRejectedValue(new Error("boom"));
    mockClient.getVehicles.mockResolvedValue([]);

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(adapter.getChargingFlag(10)).toBe(false);
  });

  it("8. a real outage still fails, leaving the cadence unchanged", async () => {
    adapter.setChargingFlag(10, true);
    mockClient.getVehicleData.mockRejectedValue(new Error("boom"));
    mockClient.getVehicles.mockRejectedValue(new Error("fleet api down"));

    const result = await adapter.fetch(makeDevice(), context);

    expect(result.success).toBe(false);
    expect(result.error).toBe("fleet api down");
    expect(adapter.getChargingFlag(10)).toBe(true);
  });
});

/**
 * Tesla's whole scheduling contribution is now the interval selector — the slot rule itself is
 * verified once, for every vendor, in `lib/vendors/__tests__/schedule.test.ts`.
 */
describe("TeslaAdapter.intervalFor", () => {
  it("uses the idle default when not charging", () => {
    expect(adapter.interval(makeDevice())).toBe(15);
  });

  it("uses the 2-minute charging default when charging", () => {
    adapter.setChargingFlag(10, true);
    expect(adapter.interval(makeDevice())).toBe(2);
  });

  it("honours a stored charging override", () => {
    adapter.setChargingFlag(10, true);
    expect(
      adapter.interval(makeDevice({ tesla: { chargingPollMinutes: 5 } })),
    ).toBe(5);
  });

  it("honours a stored idle override", () => {
    expect(
      adapter.interval(makeDevice({ tesla: { idlePollMinutes: 12 } })),
    ).toBe(12);
  });
});

describe("TeslaAdapter scheduling, end to end", () => {
  const withLastSuccess = (iso: string, metadata: unknown = null) =>
    ({
      ...makeDevice(metadata),
      pollingStatus: { lastSuccessTime: new Date(iso) },
    }) as unknown as DeviceConfigView;

  it("polls once per charging slot and not again inside it", async () => {
    adapter.setChargingFlag(10, true);
    // 2-min slots: 00:02–00:04. A success at 00:02:10 closes the 00:02 slot…
    const inSlot = await adapter.shouldPoll(
      withLastSuccess("2026-08-03T00:02:10Z"),
      false,
      new Date("2026-08-03T00:03:30Z"),
    );
    expect(inSlot.shouldPoll).toBe(false);

    // …and the 00:04 slot reopens it.
    const nextSlot = await adapter.shouldPoll(
      withLastSuccess("2026-08-03T00:02:10Z"),
      false,
      new Date("2026-08-03T00:04:05Z"),
    );
    expect(nextSlot.shouldPoll).toBe(true);
  });

  it("holds an idle car for its full 15-minute slot", async () => {
    const e = await adapter.shouldPoll(
      withLastSuccess("2026-08-03T00:00:10Z"),
      false,
      new Date("2026-08-03T00:14:00Z"),
    );
    expect(e.shouldPoll).toBe(false);
    expect(e.reason).toContain("15 min");
  });
});

describe("resolveTeslaConfig", () => {
  const cases: Array<{
    name: string;
    metadata: unknown;
    expected: {
      wakeToPoll: boolean;
      idleInterval: number;
      chargingInterval: number;
    };
  }> = [
    {
      name: "null metadata → defaults",
      metadata: null,
      expected: { wakeToPoll: true, idleInterval: 15, chargingInterval: 2 },
    },
    {
      name: "empty metadata → defaults",
      metadata: {},
      expected: { wakeToPoll: true, idleInterval: 15, chargingInterval: 2 },
    },
    {
      name: "zero charging interval → default",
      metadata: { tesla: { chargingPollMinutes: 0 } },
      expected: { wakeToPoll: true, idleInterval: 15, chargingInterval: 2 },
    },
    {
      name: "sub-minute charging interval → default",
      metadata: { tesla: { chargingPollMinutes: 0.5 } },
      expected: { wakeToPoll: true, idleInterval: 15, chargingInterval: 2 },
    },
    {
      name: "fractional charging interval is floored",
      metadata: { tesla: { chargingPollMinutes: 2.9 } },
      expected: { wakeToPoll: true, idleInterval: 15, chargingInterval: 2 },
    },
    {
      name: "one minute is allowed",
      metadata: { tesla: { chargingPollMinutes: 1 } },
      expected: { wakeToPoll: true, idleInterval: 15, chargingInterval: 1 },
    },
    {
      name: "Tez's stored blob wins over the defaults",
      metadata: {
        tesla: {
          wakeToPoll: false,
          idlePollMinutes: 12,
          chargingPollMinutes: 5,
        },
      },
      expected: { wakeToPoll: false, idleInterval: 12, chargingInterval: 5 },
    },
  ];

  it.each(cases)("$name", ({ metadata, expected }) => {
    expect(resolveTeslaConfig(makeDevice(metadata))).toEqual(expected);
  });
});
