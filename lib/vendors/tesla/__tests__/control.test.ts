/**
 * Tesla's `ControlCapability` — the behaviours inherited from the bespoke command route it
 * replaced. Each of these was a hand-written branch in that route; they now have to survive
 * generically, so they are pinned here rather than at the HTTP layer.
 *
 * The five that matter most (and the reasons):
 *   - a benign vendor decline (`result:false, reason:"not_charging"`) RESOLVES, it does not
 *     throw — otherwise stopping an already-idle charge would 500 instead of answering 200;
 *   - `TeslaCommandProtocolError` becomes a `ControlRejectedError` carrying the exact legacy
 *     message + `vehicle_command_protocol_required`, so `lib/control` never imports a Tesla
 *     symbol yet the 422 contract is unchanged;
 *   - credentials load under the DEVICE OWNER, from the device alone — an automation calls
 *     this with no session user at all;
 *   - a sleeping car is woken, and an unwakeable one is a 503 rather than a hang;
 *   - absent Fleet env is a 501, checked at INVOKE time (a module-load const would be
 *     untestable and wrong on a serverless cold start with late-injected env). Locally the env
 *     is genuinely absent, which is why every other case here sets it explicitly.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { PointRow } from "@/lib/db/planetscale/schema";

// Keep the import chain inert (no DB at import time).
jest.mock("@/lib/db/planetscale", () => ({
  planetscaleDb: null,
  requirePlanetscaleDb: () => ({}),
}));

const mockClient = {
  getVehicles: jest.fn<(token: string) => Promise<any[]>>(),
  wakeUp: jest.fn<(token: string, vehicleId: string) => Promise<boolean>>(),
  chargeStart: jest.fn<(token: string, vehicleId: string) => Promise<any>>(),
  chargeStop: jest.fn<(token: string, vehicleId: string) => Promise<any>>(),
  setChargeLimit:
    jest.fn<(token: string, vehicleId: string, percent: number) => Promise<any>>(),
  setChargingAmps:
    jest.fn<(token: string, vehicleId: string, amps: number) => Promise<any>>(),
};

jest.mock("@/lib/vendors/tesla/tesla-client", () => ({
  getTeslaClient: () => mockClient,
}));

const getValidTeslaToken = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock("@/lib/vendors/tesla/tesla-auth", () => ({
  getValidTeslaToken: (...args: any[]) => getValidTeslaToken(...args),
}));

import { TeslaControlCapability } from "../control";
import { TeslaCommandProtocolError } from "../command-signer";
import {
  ControlDispatchError,
  ControlRejectedError,
} from "@/lib/control/errors";

const capability = new TeslaControlCapability();

const device = {
  id: 10,
  ownerClerkUserId: "user_owner",
  vendorType: "tesla",
} as unknown as DeviceConfigView;

function point(logicalPath: string, metricType: string): PointRow {
  return {
    id: "019f0000-0000-7000-8000-00000000pt01",
    deviceId: "019f0000-0000-7000-8000-0000000dev10",
    logicalPath,
    metricType,
  } as unknown as PointRow;
}

const CHARGE_SWITCH = point("ev.charge", "active");
const CHARGE_LIMIT = point("ev.charge.limit", "soc");
const CHARGE_AMPS = point("ev.charge.limit", "current");

const savedEnv = { ...process.env };

function setFleetEnv() {
  process.env.TESLA_CLIENT_ID = "cid";
  process.env.TESLA_CLIENT_SECRET = "secret";
  process.env.TESLA_REDIRECT_URI = "https://example.test/cb";
}

beforeEach(() => {
  jest.clearAllMocks();
  setFleetEnv();
  getValidTeslaToken.mockResolvedValue({
    accessToken: "tok",
    credentials: {
      vehicle_id: "12345",
      fleet_api_base_url: "https://fleet.test",
    },
  });
  mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "online" }]);
  mockClient.wakeUp.mockResolvedValue(true);
  for (const fn of [
    mockClient.chargeStart,
    mockClient.chargeStop,
    mockClient.setChargeLimit,
    mockClient.setChargingAmps,
  ]) {
    fn.mockResolvedValue({ result: true, reason: "" });
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("preconditions", () => {
  it("501s (as a ControlDispatchError) with no Fleet API config", async () => {
    delete process.env.TESLA_CLIENT_ID;
    const err = await capability
      .invoke({ device, point: CHARGE_SWITCH, action: "turn_on" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ControlDispatchError);
    expect(err.httpStatus).toBe(501);
    expect(err.message).toBe(
      "Tesla charge control requires Fleet API configuration",
    );
    // Checked before anything else — no token fetch on a misconfigured deployment.
    expect(getValidTeslaToken).not.toHaveBeenCalled();
  });

  it("400s when the device has no owner (there are no credentials to use)", async () => {
    const ownerless = { ...device, ownerClerkUserId: null } as DeviceConfigView;
    const err = await capability
      .invoke({ device: ownerless, point: CHARGE_SWITCH, action: "turn_on" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ControlDispatchError);
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe("System has no owner");
  });

  it("🛑 loads credentials under the DEVICE OWNER, with no session user involved", async () => {
    await capability.invoke({ device, point: CHARGE_SWITCH, action: "turn_on" });
    expect(getValidTeslaToken).toHaveBeenCalledWith("user_owner", 10);
  });
});

describe("(point, action) → Fleet command", () => {
  it("turn_on on ev.charge/active → chargeStart", async () => {
    await capability.invoke({ device, point: CHARGE_SWITCH, action: "turn_on" });
    expect(mockClient.chargeStart).toHaveBeenCalledWith("tok", "12345");
    expect(mockClient.chargeStop).not.toHaveBeenCalled();
  });

  it("turn_off on ev.charge/active → chargeStop", async () => {
    await capability.invoke({
      device,
      point: CHARGE_SWITCH,
      action: "turn_off",
    });
    expect(mockClient.chargeStop).toHaveBeenCalledWith("tok", "12345");
  });

  it("set_value on ev.charge.limit/soc → setChargeLimit(percent)", async () => {
    await capability.invoke({
      device,
      point: CHARGE_LIMIT,
      action: "set_value",
      value: 80,
    });
    expect(mockClient.setChargeLimit).toHaveBeenCalledWith("tok", "12345", 80);
  });

  it("set_value on ev.charge.limit/current → setChargingAmps(amps)", async () => {
    await capability.invoke({
      device,
      point: CHARGE_AMPS,
      action: "set_value",
      value: 16,
    });
    expect(mockClient.setChargingAmps).toHaveBeenCalledWith("tok", "12345", 16);
  });

  it("throws a plain Error for an unmapped (point, action) — a server config bug", async () => {
    const err = await capability
      .invoke({ device, point: point("ev.battery", "soc"), action: "turn_on" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ControlDispatchError);
    expect(err).not.toBeInstanceOf(ControlRejectedError);
    // Resolved before any network call: nothing was sent to the car.
    expect(getValidTeslaToken).not.toHaveBeenCalled();
  });
});

describe("the wake dance", () => {
  it("404s when the vehicle is absent from getVehicles", async () => {
    mockClient.getVehicles.mockResolvedValue([{ id: 999, state: "online" }]);
    const err = await capability
      .invoke({ device, point: CHARGE_SWITCH, action: "turn_on" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ControlDispatchError);
    expect(err.httpStatus).toBe(404);
    expect(err.message).toBe("Vehicle 12345 not found");
  });

  it("wakes a sleeping vehicle, then dispatches", async () => {
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "asleep" }]);
    mockClient.wakeUp.mockResolvedValue(true);
    const result = await capability.invoke({
      device,
      point: CHARGE_SWITCH,
      action: "turn_on",
    });
    expect(mockClient.wakeUp).toHaveBeenCalledWith("tok", "12345");
    expect(mockClient.chargeStart).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, reason: undefined });
  });

  it("503s when the vehicle will not wake", async () => {
    mockClient.getVehicles.mockResolvedValue([{ id: 12345, state: "asleep" }]);
    mockClient.wakeUp.mockResolvedValue(false);
    const err = await capability
      .invoke({ device, point: CHARGE_SWITCH, action: "turn_on" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ControlDispatchError);
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe(
      "Vehicle is asleep and did not wake up; try again shortly",
    );
    expect(mockClient.chargeStart).not.toHaveBeenCalled();
  });
});

describe("outcomes", () => {
  it("🛑 RESOLVES a benign vendor decline — it must never become an error", async () => {
    mockClient.chargeStop.mockResolvedValue({
      result: false,
      reason: "not_charging",
    });
    const result = await capability.invoke({
      device,
      point: CHARGE_SWITCH,
      action: "turn_off",
    });
    expect(result).toEqual({ ok: false, reason: "not_charging" });
  });

  it("translates TeslaCommandProtocolError into a ControlRejectedError", async () => {
    mockClient.chargeStart.mockRejectedValue(
      new TeslaCommandProtocolError("Vehicle requires signed commands: 403"),
    );
    const err = await capability
      .invoke({ device, point: CHARGE_SWITCH, action: "turn_on" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ControlRejectedError);
    expect(err.code).toBe("vehicle_command_protocol_required");
    expect(err.message).toBe(
      "This vehicle requires signed commands (Tesla Vehicle Command protocol), which isn't supported yet.",
    );
  });

  it("rethrows anything else unchanged", async () => {
    const boom = new Error("Tesla command 'charge_start' failed: 500");
    mockClient.chargeStart.mockRejectedValue(boom);
    await expect(
      capability.invoke({ device, point: CHARGE_SWITCH, action: "turn_on" }),
    ).rejects.toBe(boom);
  });
});
