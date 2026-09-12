import { describe, it, expect, jest } from "@jest/globals";
import axios from "axios";
import { Inverter } from "../../clients/fronius/inverter";
import { createFusher } from "../fusher";
const harvest = jest.fn();
jest.mock("../../clients/fronius/site", () => ({
  Site: class {
    startPolling() {}
    captureHarvest(...args: unknown[]) {
      harvest(...args);
    }
    generateFroniusMinutely() {
      return null;
    }
  },
}));

describe("production Fronius trial capture", () => {
  it("records every raw inverter input with an integration timestamp", async () => {
    const raw = {
      Body: { Data: { Site: { P_PV: 100 }, Inverters: { "1": { SOC: 50 } } } },
    };
    const get = jest.spyOn(axios, "get").mockResolvedValue({ data: raw });
    try {
      const inverter = new Inverter("192.0.2.1", "test", true, {
        manufacturer: "Fronius",
        model: "test",
        pvPowerW: 0,
        customName: "test",
        serialNumber: "test",
      });
      const capture = jest.fn();
      Object.assign(inverter, { onTrialSample: capture });
      const values = await inverter.fetchPowerFlow();
      expect(values?.solarW).toBe(100);
      expect(capture).toHaveBeenCalledWith(expect.any(Date), raw);
    } finally {
      get.mockRestore();
    }
  });
  it("records a minutely harvest even when it is only the baseline", () => {
    const source = createFusher({ siteId: "site", inverters: [] });
    source.capture?.("2026-09-12T00:00:00Z", []);
    expect(harvest).toHaveBeenCalledWith("2026-09-12T00:00:00Z", []);
  });
});

it("reports actual background read failures and excludes report harvests", async () => {
  const inverter = new Inverter("192.0.2.1", "test", true, {
    manufacturer: "Fronius",
    model: "test",
    pvPowerW: 0,
    customName: "test",
    serialNumber: "test",
  });
  const record = jest.fn();
  Object.assign(inverter, { onProductionRead: record });
  const failure = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const get = jest.spyOn(axios, "get").mockRejectedValue(failure);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await inverter.fetchPowerFlow()).toBeNull();
    expect(record).toHaveBeenCalledWith(expect.any(Number), false, failure);
    const source = createFusher({ siteId: "kinkora", inverters: [] });
    expect(source).toMatchObject({ productionReadsInBackground: true });
  } finally {
    get.mockRestore();
    log.mockRestore();
  }
});

it("records valid and malformed power-flow responses without diagnostic failures escaping", async () => {
  const inverter = new Inverter("192.0.2.1", "test", true, {
    manufacturer: "Fronius",
    model: "test",
    pvPowerW: 0,
    customName: "test",
    serialNumber: "test",
  });
  const record = jest.fn();
  Object.assign(inverter, { onProductionRead: record });
  const get = jest
    .spyOn(axios, "get")
    .mockResolvedValueOnce({
      data: { Body: { Data: { Site: { P_PV: 100 } } } },
    })
    .mockResolvedValue({ data: {} });
  try {
    expect((await inverter.fetchPowerFlow())?.solarW).toBe(100);
    expect(record).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      undefined,
    );
    expect(await inverter.fetchPowerFlow()).toBeNull();
    expect(record).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      undefined,
    );
    Object.assign(inverter, {
      onProductionRead: () => {
        throw new Error("diagnostic failure");
      },
    });
    expect(await inverter.fetchPowerFlow()).toBeNull();
  } finally {
    get.mockRestore();
  }
});
