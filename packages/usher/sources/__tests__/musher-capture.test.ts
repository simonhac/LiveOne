import { it, expect, jest } from "@jest/globals";
import { createMusher } from "../musher";
import { captureTrial } from "../../core/trial-capture";
jest.mock("../../core/trial-capture", () => ({ captureTrial: jest.fn() }));
jest.mock("../../clients/dse-client", () => ({
  ...jest.requireActual<object>("../../clients/dse-client"),
  DseClient: class {
    async connect() {}
    async close() {}
    async readAll() {
      return {
        readings: [
          { field: { key: "engineRpm" }, value: 1500, rawWords: [1500] },
        ],
      };
    }
  },
}));
it("captures DSE raw words with the exact harvested readings and time", async () => {
  const source = createMusher({ siteId: "site", host: "192.0.2.1" });
  await source.read();
  const expected = [
    {
      physicalPathTail: "engine_rpm",
      metricType: "speed",
      metricUnit: "rpm",
      value: 1500,
    },
  ];
  source.capture?.("2026-09-12T00:00:00Z", expected);
  expect(captureTrial).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "deepsea",
      pollerId: "site",
      at: "2026-09-12T00:00:00Z",
      raw: { engineRpm: [1500] },
      expected,
      harvest: true,
    }),
  );
});
