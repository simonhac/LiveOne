import { randomUUID } from "node:crypto";
import type { Attributes, Meter } from "@opentelemetry/api";
import { AggregationType, type ViewOptions } from "@opentelemetry/sdk-metrics";

// Also a point attribute: backend resource-label retention is not assumed.
export const telemetryInstanceId = randomUUID();

export const READ_BOUNDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];
export const readViews: ViewOptions[] = [
  {
    instrumentName: "liveone.read.duration",
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: READ_BOUNDS },
    },
    aggregationCardinalityLimit: 4096,
  },
];
export type Vendor = "fronius" | "deepsea" | "selectronic" | "sigenergy";
export type Outcome = "success" | "partial" | "error" | "cancelled";
export type ErrorType =
  | "timeout"
  | "connection"
  | "authentication"
  | "rate_limit"
  | "invalid_response"
  | "device_error"
  | "cancelled"
  | "other";
export interface ReadIdentity {
  deviceId: string;
  readerId: string;
  vendor: Vendor;
}
export type FinishRead = (outcome: Outcome, error?: unknown) => void;
export const noopRead: FinishRead = () => {};
export const opaqueId = /^[a-zA-Z0-9_-]{1,80}$/;
export function telemetryEnvironment(): string {
  if (process.env.NODE_ENV === "test") return "test";
  if (
    ["production", "preview", "development"].includes(
      process.env.VERCEL_ENV ?? "",
    )
  )
    return process.env.VERCEL_ENV!;
  return process.env.NODE_ENV === "production" ? "production" : "development";
}
export function classifyReadError(error: unknown): ErrorType {
  try {
    return classifyError(error);
  } catch {
    return "other";
  }
}
function classifyError(error: unknown): ErrorType {
  const e = error as
    | {
        status?: number;
        response?: { status?: number };
        code?: string | number;
        errorCode?: string;
        kind?: string;
        errorKind?: string;
        name?: string;
      }
    | undefined;
  const code = String(e?.code ?? e?.errorCode ?? "");
  const status = e?.response?.status ?? e?.status ?? Number(code);
  const kind = e?.kind ?? e?.errorKind;
  if (
    status === 429 ||
    code === "1110" ||
    kind === "rate-limit" ||
    code === "rate-limit"
  )
    return "rate_limit";
  if (status === 401 || status === 403 || kind === "auth" || code === "auth")
    return "authentication";
  if (
    e?.name === "TimeoutError" ||
    ["ETIMEDOUT", "ECONNABORTED", "timeout"].includes(code) ||
    kind === "timeout"
  )
    return "timeout";
  if (e?.name === "AbortError" || code === "ERR_CANCELED") return "cancelled";
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code) ||
    kind === "network"
  )
    return "connection";
  if (["empty", "invalid_response"].includes(code) || kind === "parse")
    return "invalid_response";
  if (kind === "device_error" || status >= 500) return "device_error";
  return "other";
}

/** Bounded, process-local aggregation. Metrics failures never escape into collection. */
export function createReadMetrics(
  meter: Meter,
  service: string,
  environment = telemetryEnvironment(),
  clock = { wall: () => Date.now(), mono: () => performance.now() },
) {
  const attempts = meter.createCounter("liveone.read.attempts", {
    unit: "{read}",
  });
  const completions = meter.createCounter("liveone.read.completions", {
    unit: "{read}",
  });
  const duration = meter.createHistogram("liveone.read.duration", {
    unit: "s",
    advice: { explicitBucketBoundaries: READ_BOUNDS },
  });
  const state = new Map<
    string,
    {
      attrs: Attributes;
      started?: number;
      completed?: number;
      success?: number;
    }
  >();
  for (const [name, key] of [
    ["last_started", "started"],
    ["last_completed", "completed"],
    ["last_success", "success"],
  ] as const) {
    meter
      .createObservableGauge(`liveone.read.${name}`, { unit: "s" })
      .addCallback((obs) => {
        for (const s of state.values())
          if (s[key] !== undefined) obs.observe(s[key]!, s.attrs);
      });
  }
  return {
    begin(identity: ReadIdentity): FinishRead {
      try {
        if (
          !opaqueId.test(identity.deviceId) ||
          !opaqueId.test(identity.readerId)
        )
          return noopRead;
        const key = `${identity.vendor}/${identity.deviceId}/${identity.readerId}`;
        let s = state.get(key);
        if (!s) {
          if (state.size >= 512) return noopRead;
          s = {
            attrs: {
              service,
              "service.instance.id": telemetryInstanceId,
              environment,
              vendor: identity.vendor,
              "device.id": identity.deviceId,
              "reader.id": identity.readerId,
            },
          };
          state.set(key, s);
        }
        const started = clock.mono();
        s.started = clock.wall() / 1000;
        attempts.add(1, s.attrs);
        let finished = false;
        return (outcome, error) => {
          if (finished) return;
          finished = true;
          try {
            const attrs = { ...s!.attrs, outcome };
            s!.completed = clock.wall() / 1000;
            if (outcome === "success") s!.success = s!.completed;
            completions.add(
              1,
              outcome === "success"
                ? attrs
                : {
                    ...attrs,
                    "error.type":
                      outcome === "cancelled"
                        ? "cancelled"
                        : classifyReadError(error),
                  },
            );
            duration.record(Math.max(0, clock.mono() - started) / 1000, attrs);
          } catch {
            /* Collection has priority. */
          }
        };
      } catch {
        return noopRead;
      }
    },
  };
}
