import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { createReadMetrics } from "../index";
import { createTelemetryProvider } from "../runtime";
import {
  initTelemetry,
  getMeter,
  shutdownTelemetry,
} from "../../../usher/core/telemetry";

it.each(["cloud", "hub"])(
  "%s exports the first read and only new counts on subsequent exports",
  async (host) => {
    const batches: ResourceMetrics[] = [];
    const exportSpy = jest
      .spyOn(OTLPMetricExporter.prototype, "export")
      .mockImplementation((metrics, callback) => {
        batches.push(structuredClone(metrics));
        callback({ code: ExportResultCode.SUCCESS });
      });
    const saved = { ...process.env };
    let close: (() => Promise<void>) | undefined;
    try {
      // A deployment default must not silently restore the incompatible mode.
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE =
        "cumulative";
      const provider =
        host === "cloud"
          ? createTelemetryProvider(
              "liveone",
              "https://metrics.example/v1/metrics",
              "test",
            )!
          : null;
      if (host === "hub") {
        process.env.BETTERSTACK_SOURCE_TOKEN = "test";
        process.env.BETTERSTACK_METRICS_ENDPOINT =
          "https://metrics.example/v1/metrics";
        initTelemetry(() => {});
      }
      close = provider ? () => provider.shutdown() : shutdownTelemetry;
      const reads = createReadMetrics(
        provider ? provider.getMeter("test") : getMeter("test"),
        "liveone",
        "test",
      );
      const id = {
        vendor: "sigenergy" as const,
        deviceId: "test",
        readerId: "test",
      };
      reads.begin(id)("success");
      reads.begin(id)("error", { code: "timeout" });
      // The SDK timestamps its series with millisecond resolution. A zero-length
      // first interval denotes an unknown-start reset in OTLP, not a normal read.
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (provider) {
        await provider.forceFlush();
        await provider.forceFlush();
        reads.begin(id)("success");
        await new Promise((resolve) => setTimeout(resolve, 10));
        await provider.forceFlush();
      }
      await close();
      close = undefined;
      const metrics = batches.flatMap((b) =>
        b.scopeMetrics.flatMap((s) => s.metrics),
      );
      for (const name of [
        "liveone.read.completions",
        "liveone.read.duration",
      ]) {
        const exports = metrics.filter((m) => m.descriptor.name === name);
        expect(exports.length).toBeGreaterThan(0);
        expect(
          exports.every(
            (m) => m.aggregationTemporality === AggregationTemporality.DELTA,
          ),
        ).toBe(true);
        const rows = exports.flatMap((m) => m.dataPoints);
        const count = (p: (typeof rows)[number]) =>
          typeof p.value === "number" ? p.value : p.value.count;
        expect(rows.reduce((n, p) => n + count(p), 0)).toBe(
          host === "cloud" ? 3 : 2,
        );
        expect(
          rows
            .filter((p) => p.attributes.outcome === "error")
            .reduce((n, p) => n + count(p), 0),
        ).toBe(1);
      }
    } finally {
      await close?.();
      exportSpy.mockRestore();
      process.env = saved;
    }
  },
);
