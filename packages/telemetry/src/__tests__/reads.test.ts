import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  createReadMetrics,
  classifyReadError,
  READ_BOUNDS,
  readViews,
} from "../index";

class Reader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}
const identity = {
  vendor: "fronius" as const,
  deviceId: "device-1",
  readerId: "reader-1",
};
async function fixture() {
  const reader = new Reader();
  const provider = new MeterProvider({ readers: [reader], views: readViews });
  let wall = 100000,
    mono = 0;
  const reads = createReadMetrics(
    provider.getMeter("test"),
    "liveone-usher",
    "test",
    { wall: () => wall, mono: () => mono },
  );
  return {
    provider,
    reads,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    metrics: async () =>
      (await reader.collect()).resourceMetrics.scopeMetrics.flatMap(
        (s) => s.metrics,
      ),
  };
}
it("records a hung attempt without inventing completion or success", async () => {
  const f = await fixture();
  f.reads.begin(identity);
  const m = await f.metrics();
  expect(
    m.find((x) => x.descriptor.name.endsWith("attempts"))!.dataPoints[0].value,
  ).toBe(1);
  expect(
    m.find((x) => x.descriptor.name.endsWith("last_started"))!.dataPoints[0]
      .value,
  ).toBe(100);
  expect(m.some((x) => x.descriptor.name.endsWith("last_success"))).toBe(false);
  expect(m.some((x) => x.descriptor.name.endsWith("completions"))).toBe(false);
  await f.provider.shutdown();
});
it("counts concurrent readers exactly once, preserves success timestamp and histogram buckets", async () => {
  const f = await fixture();
  const finish = f.reads.begin(identity);
  const other = f.reads.begin({ ...identity, readerId: "reader-2" });
  f.advance(250);
  finish("success");
  finish("error");
  other("partial", { kind: "device_error" });
  f.advance(1000);
  f.reads.begin(identity)("error", { status: 429 });
  const m = await f.metrics();
  const completions = m.find((x) => x.descriptor.name.endsWith("completions"))!;
  expect(completions.dataPoints.reduce((n, p) => n + Number(p.value), 0)).toBe(
    3,
  );
  expect(
    completions.dataPoints.find(
      (p) => p.attributes["error.type"] === "rate_limit",
    ),
  ).toBeDefined();
  expect(
    m.find((x) => x.descriptor.name.endsWith("last_success"))!.dataPoints[0]
      .value,
  ).toBe(100.25);
  const hist = m.find((x) => x.descriptor.name.endsWith("duration"))!;
  expect((hist.dataPoints[0].value as any).buckets.boundaries).toEqual(
    READ_BOUNDS,
  );
  expect(hist.dataPoints.every((p) => !("error.type" in p.attributes))).toBe(
    true,
  );
  expect(JSON.stringify(m)).not.toContain("device_error raw message");
  await f.provider.shutdown();
});
it("starts new process counters at zero and does not share timestamps", async () => {
  const first = await fixture();
  first.reads.begin(identity)("success");
  await first.provider.shutdown();
  const next = await fixture();
  expect(await next.metrics()).toEqual([]);
  next.reads.begin(identity)("cancelled");
  expect(
    (await next.metrics()).some((m) =>
      m.descriptor.name.endsWith("last_success"),
    ),
  ).toBe(false);
  await next.provider.shutdown();
});
it.each([
  [{ status: 429 }, "rate_limit"],
  [{ status: 200, kind: "rate-limit" }, "rate_limit"],
  [{ code: 1110 }, "rate_limit"],
  [{ kind: "auth" }, "authentication"],
  [{ errorCode: "200", errorKind: "auth" }, "authentication"],
  [{ code: "ECONNRESET" }, "connection"],
  [{ name: "AbortError" }, "cancelled"],
  [{ code: "ETIMEDOUT" }, "timeout"],
  [{ code: "empty" }, "invalid_response"],
  [new Error("a private hostname"), "other"],
])(
  "classifies structured errors without exposing messages",
  (error, expected) => expect(classifyReadError(error)).toBe(expected),
);
it("does not let instrument failures escape", async () => {
  const f = await fixture();
  const broken = { ...identity, deviceId: "http://private-host" };
  expect(() => f.reads.begin(broken)("success")).not.toThrow();
  expect(await f.metrics()).toEqual([]);
  await f.provider.shutdown();
});
