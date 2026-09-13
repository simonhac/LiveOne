import { after } from "next/server";
import {
  createReadMetrics,
  noopRead,
  classifyReadError,
  type Vendor,
} from "@liveone/telemetry";
import { createTelemetryProvider } from "@liveone/telemetry/runtime";

let telemetry: ReturnType<typeof createReadMetrics> | undefined;
let provider: ReturnType<typeof createTelemetryProvider>;
let flushing: Promise<void> | undefined;
let flushGeneration = 0;
async function flushMetrics() {
  flushGeneration++;
  if (!flushing) {
    flushing = (async () => {
      // Coalesce concurrent function completions. At most two bounded exports;
      // overload remains in cumulative memory for the next invocation, never a queue.
      for (let pass = 0; pass < 2; pass++) {
        const generation = flushGeneration;
        await provider!.forceFlush({ timeoutMillis: 4000 });
        if (generation === flushGeneration) break;
      }
    })().finally(() => {
      flushing = undefined;
    });
  }
  await flushing;
}

function beginCloudRead(vendor: Vendor, deviceId: string | undefined) {
  if (!deviceId) return noopRead;
  try {
    if (!provider) {
      provider = createTelemetryProvider(
        "liveone",
        process.env.LIVEONE_METRICS_ENDPOINT,
        process.env.LIVEONE_METRICS_TOKEN,
      );
      if (!provider) return noopRead;
      telemetry = createReadMetrics(
        provider.getMeter("liveone/production-reads"),
        "liveone",
      );
    }
    // Register while still in the request context. The bounded flush runs after the response,
    // including when later processing/delivery fails. Each invocation gets its own callback.
    after(async () => {
      try {
        await flushMetrics();
      } catch {
        console.error("production telemetry export failed");
      }
    });
    return telemetry!.begin({ vendor, deviceId, readerId: deviceId });
  } catch {
    // Includes callers outside a Next request. Never invent a fire-and-forget flush.
    return noopRead;
  }
}

export async function observeCloudRead<
  T extends {
    success: boolean;
    readings?: Array<{ rawValue: unknown; error?: string | null }>;
    errorCode?: string;
  },
>(
  vendor: Vendor,
  deviceId: string | undefined,
  fetch: () => Promise<T>,
): Promise<T> {
  const finish = beginCloudRead(vendor, deviceId);
  try {
    const result = await fetch();
    try {
      const valid = result.readings?.some(
        (r) =>
          !r.error &&
          typeof r.rawValue === "number" &&
          Number.isFinite(r.rawValue),
      );
      finish(
        result.success && valid ? "success" : "error",
        result.success && !valid ? { code: "invalid_response" } : result,
      );
    } catch {
      /* Diagnostics cannot change a vendor result. */
    }
    return result;
  } catch (error) {
    finish(
      classifyReadError(error) === "cancelled" ? "cancelled" : "error",
      error,
    );
    throw error;
  }
}
