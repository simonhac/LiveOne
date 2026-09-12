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
