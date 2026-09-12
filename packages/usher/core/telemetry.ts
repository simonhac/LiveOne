/**
 * OTel metrics export to Better Stack, for the usher hub on Fly (`liveone-flyhub`).
 *
 * Why a push exporter and not Fly's `[metrics]` scrape block: Fly's scraper reaches an app over the
 * private 6PN network, and this Next server is bound to `HOSTNAME=127.0.0.1` on purpose (the
 * Dockerfile says so — cloudflared fronts the inspector at usher.liveone.energy and the Fly IP
 * exposes only the WireGuard UDP port). Exposing a scrape endpoint would mean re-binding the
 * inspector to 6PN, which undoes a deliberate decision for the sake of a metrics port. Pushing
 * costs nothing and changes no listener.
 *
 * THE ENDPOINT MUST BE THIS SOURCE'S OWN INGESTING HOST. There is no shared ingest URL:
 * `https://in-otel.logs.betterstack.com/v1/metrics` — which mrtippy hardcodes — is region-pinned,
 * and returns 401 {"message":"Unauthorized"} for a token belonging to a source in another region
 * (probed 2026-09-12). mrtippy's works only because its source sits in the region that host points
 * at. Hence no default here: a wrong default buys a 401 every 60 seconds forever.
 *
 * Shape matches clara's bot/src/lib/telemetry.ts and mrtippy's bot/src/lib/telemetry.ts, including
 * the metric names, so one dashboard layout serves all three.
 */

import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type {
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const SERVICE_NAME = "liveone-usher";

export interface TelemetryHandle {
  shutdown: () => Promise<void>;
}

let provider: MeterProvider | null = null;

/**
 * Build the meter provider. Idempotent — a second call returns the existing one, because Next's
 * `register()` can run more than once in dev.
 */
export function initTelemetry(log: (m: string) => void = console.log): void {
  if (provider) return;

  const token = process.env.BETTERSTACK_SOURCE_TOKEN;
  const endpoint = process.env.BETTERSTACK_METRICS_ENDPOINT;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
  });

  if (!token) {
    // No token is a legitimate state (a Pi, a laptop, a test). Gauges still register and go nowhere,
    // so there is no separate untested code path.
    provider = new MeterProvider({ resource });
    log("telemetry: metrics export disabled (no BETTERSTACK_SOURCE_TOKEN)");
    return;
  }

  if (!endpoint) {
    // Loud, and NOT fatal: the usher's job is to keep polling generators and inverters. Losing
    // metrics must never cost a reading. This is the one place the two differ from clara, which
    // throws — clara is a chat bot, the usher is data collection that runs unattended.
    provider = new MeterProvider({ resource });
    log(
      "telemetry: BETTERSTACK_SOURCE_TOKEN is set but BETTERSTACK_METRICS_ENDPOINT is not — " +
        "metrics DISABLED. Set it to this source's own ingesting host, e.g. " +
        "https://sNNNNNNN.<region>.betterstackdata.com/v1/metrics (shown on the source in Better " +
        "Stack, and returned as `ingesting_host` by GET /api/v2/sources). The shared-looking " +
        "in-otel.logs.betterstack.com is region-pinned and will 401.",
    );
    return;
  }

  const inner = new OTLPMetricExporter({
    url: endpoint,
    headers: { Authorization: `Bearer ${token}` },
  });

  let loggedFirstSuccess = false;

  // Wrapped only so a failing export is visible. A silently-failing exporter is indistinguishable
  // from a healthy idle process, which is the exact failure this work exists to remove.
  const exporter: PushMetricExporter = {
    export(
      metrics: ResourceMetrics,
      resultCallback: (result: ExportResult) => void,
    ) {
      inner.export(metrics, (result) => {
        if (result.code === ExportResultCode.FAILED) {
          log(`telemetry: metric export failed — ${result.error?.message}`);
        } else if (!loggedFirstSuccess) {
          loggedFirstSuccess = true;
          log("telemetry: metric export succeeded (first batch)");
        }
        resultCallback(result);
      });
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
    selectAggregationTemporality:
      inner.selectAggregationTemporality?.bind(inner),
    selectAggregation: inner.selectAggregation?.bind(inner),
  };

  provider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      }),
    ],
  });

  log(`telemetry: metrics → ${endpoint}`);
}

export function getMeter(name: string) {
  if (!provider) initTelemetry();
  return provider!.getMeter(name);
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown();
  provider = null;
}

/** Test seam — drop the provider so a fresh init can be observed. */
export function __resetTelemetryForTests(): void {
  provider = null;
}
