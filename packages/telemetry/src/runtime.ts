import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { readViews, telemetryInstanceId } from "./index";

/** No default endpoint: tokens belong to a specific Better Stack ingesting host. */
export function createTelemetryProvider(
  service: string,
  endpoint?: string,
  token?: string,
  periodic = false,
) {
  if (!endpoint || !token) return null;
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Invalid telemetry endpoint");
  const exporter = new OTLPMetricExporter({
    url: endpoint,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMillis: 3000,
  });
  return new MeterProvider({
    resource: resourceFromAttributes({
      "service.name": service,
      "service.version":
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.SERVICE_VERSION ??
        process.env.FLY_IMAGE_REF ??
        "development",
      "service.instance.id": telemetryInstanceId,
    }),
    views: readViews,
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: periodic ? 60000 : 2147483647,
        exportTimeoutMillis: 4000,
      }),
    ],
  });
}
