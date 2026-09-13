import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { readViews } from "@liveone/telemetry";

const mockCallbacks: Array<() => Promise<void>> = [];
let mockProvider: MeterProvider;
const mockFlush = jest.fn(async () => {});
jest.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => {
    mockCallbacks.push(callback);
  },
}));
jest.mock("@liveone/telemetry/runtime", () => ({
  createTelemetryProvider: () => ({
    getMeter: (name: string) => mockProvider.getMeter(name),
    forceFlush: mockFlush,
  }),
}));
import { observeCloudRead } from "../production-reads";
class Reader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}
const reader = new Reader();
beforeAll(() => {
  mockProvider = new MeterProvider({ readers: [reader], views: readViews });
});
afterAll(async () => mockProvider.shutdown());
beforeEach(() => {
  mockCallbacks.length = 0;
  mockFlush.mockClear();
});
it("preserves vendor results and flushes after the request, not within a read", async () => {
  const result = { success: true, readings: [{ rawValue: 0 }] };
  expect(
    await observeCloudRead("sigenergy", "device-a", async () => result),
  ).toBe(result);
  expect(mockFlush).not.toHaveBeenCalled();
  expect(mockCallbacks).toHaveLength(1);
  await mockCallbacks[0]();
  expect(mockFlush).toHaveBeenCalledTimes(1);
});
it("preserves errors and empty-result behavior while reporting telemetry failure", async () => {
  const result = { success: false, errorCode: "200", errorKind: "rate-limit" };
  expect(
    await observeCloudRead("sigenergy", "device-b", async () => result),
  ).toBe(result);
  const empty = { success: true, readings: [] };
  expect(
    await observeCloudRead("selectronic", "device-c", async () => empty),
  ).toBe(empty);
  const error = Object.assign(new Error("private detail"), {
    code: "ECONNRESET",
  });
  await expect(
    observeCloudRead("selectronic", "device-d", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const metrics = (await reader.collect()).resourceMetrics.scopeMetrics.flatMap(
    (s) => s.metrics,
  );
  const rows = metrics.find(
    (m) => m.descriptor.name === "liveone.read.completions",
  )!.dataPoints;
  expect(
    rows.find((r) => r.attributes["device.id"] === "device-b")!.attributes[
      "error.type"
    ],
  ).toBe("rate_limit");
  expect(
    rows.find((r) => r.attributes["device.id"] === "device-c")!.attributes[
      "error.type"
    ],
  ).toBe("invalid_response");
  expect(JSON.stringify(metrics)).not.toContain("private detail");
});
it("coalesces concurrent flushes and contains exporter failures", async () => {
  await Promise.all(
    ["device-e", "device-f"].map((id) =>
      observeCloudRead("sigenergy", id, async () => ({
        success: true,
        readings: [{ rawValue: 1 }],
      })),
    ),
  );
  mockFlush.mockRejectedValueOnce(new Error("export unavailable"));
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await Promise.all(mockCallbacks.map((fn) => fn()));
    expect(mockFlush).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});
