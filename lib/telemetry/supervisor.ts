import { createHash } from "node:crypto";
import { z } from "zod";
import type { Meter } from "@opentelemetry/api";
import {
  observationTarget,
  boundedJSON,
  secureEndpoint,
  type DataObservation,
} from "./data-observer";

export const supervisorPolicy = z
  .object({
    version: z.literal(1),
    // Deliberate gate: a synthetic/untested backend query cannot authorize device access.
    backendVerified: z.literal(true),
    baselineStart: z.string().datetime(),
    baselineEnd: z.string().datetime(),
    targets: z
      .array(
        observationTarget
          .extend({
            source: z.string().regex(/^t[0-9]+_[a-zA-Z0-9_]+_metrics$/),
            service: z.enum(["liveone-usher", "liveone"]),
            readCadenceSec: z.number().positive().max(3600),
            statWindowSec: z
              .number()
              .int()
              .min(900)
              .max(21600)
              .refine((n) => n % 900 === 0),
            minimumSamples: z.number().int().min(20),
            maxFailureRate: z.number().min(0).max(1),
            maxP95Sec: z.number().positive().max(120),
            maxMetricAgeSec: z.number().int().min(60).max(120),
            maxReadAgeSec: z.number().positive().max(3600),
            maxDataAgeSec: z.number().positive().max(7200),
            minimumCoverage: z.number().positive().max(1),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      Date.parse(p.baselineEnd) - Date.parse(p.baselineStart) < 86400000 ||
      Date.parse(p.baselineEnd) > Date.now()
    )
      ctx.addIssue({
        code: "custom",
        message: "At least 24 hours of completed production baseline required",
      });
    const unique = new Set<string>();
    const assignments = new Map<string, string>();
    for (const t of p.targets) {
      const identity = `${t.revision}/${t.deviceId}/${t.vendor}`;
      if (
        assignments.has(t.pollerId) &&
        assignments.get(t.pollerId) !== identity
      )
        ctx.addIssue({
          code: "custom",
          message: "Inconsistent assignment identity",
        });
      assignments.set(t.pollerId, identity);
      const key = `${t.pollerId}/${t.pointId}`;
      if (unique.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate observation target",
        });
      unique.add(key);
      if (t.minimumSamples > t.statWindowSec / t.readCadenceSec)
        ctx.addIssue({
          code: "custom",
          message: "Statistical window cannot provide required samples",
        });
      if (t.vendor === "sigenergy" && t.readCadenceSec < 300)
        ctx.addIssue({
          code: "custom",
          message: "Sigenergy requires at least five minutes",
        });
    }
  });
export type SupervisorTarget = z.infer<
  typeof supervisorPolicy
>["targets"][number];
export function policyHash(bytes: string) {
  return createHash("sha256").update(bytes).digest("hex");
}
export interface ReadEvidence {
  asOf: number;
  metricAt: number;
  lastSuccess: number;
  samples: number;
  failures: number;
  p95Sec: number;
  windowEnd: number;
}
export interface WindowState {
  end: number;
  consecutive: number;
}

/** Pure decisions. Statistical breaches need two distinct consecutive windows. */
export function evaluateHealth(
  t: SupervisorTarget,
  data: DataObservation,
  read: ReadEvidence,
  previous: WindowState | undefined,
  now: number,
) {
  const fresh = (timestamp: number | undefined, age: number) =>
    timestamp !== undefined &&
    Number.isFinite(timestamp) &&
    timestamp <= now &&
    now - timestamp <= age;
  const expectedWindow =
    Math.floor((read.asOf - 120) / t.statWindowSec) * t.statWindowSec;
  const inputsValid =
    (!previous ||
      (Number.isFinite(previous.end) &&
        previous.end >= 0 &&
        previous.end <= read.windowEnd &&
        Number.isInteger(previous.consecutive) &&
        previous.consecutive >= 0)) &&
    fresh(read.asOf, 60) &&
    read.asOf === data.asOf &&
    data.observedAt >= data.asOf &&
    fresh(data.observedAt, 120) &&
    fresh(read.metricAt, t.maxMetricAgeSec) &&
    fresh(read.lastSuccess, t.maxReadAgeSec) &&
    fresh(data.lastMeasurement, t.maxDataAgeSec) &&
    fresh(data.lastReceived, t.maxDataAgeSec) &&
    data.windowEnd === Math.floor((data.asOf - 120) / 900) * 900 &&
    data.coverage >= t.minimumCoverage &&
    read.windowEnd === expectedWindow &&
    Number.isInteger(read.samples) &&
    read.samples >= t.minimumSamples &&
    Number.isInteger(read.failures) &&
    read.failures >= 0 &&
    read.failures <= read.samples &&
    Number.isFinite(read.p95Sec) &&
    read.p95Sec >= 0;
  const bad =
    read.failures / read.samples > t.maxFailureRate ||
    read.p95Sec > t.maxP95Sec;
  let state = previous ?? { end: 0, consecutive: 0 };
  if (inputsValid && read.windowEnd > state.end)
    state = {
      end: read.windowEnd,
      consecutive: bad
        ? (state.end === read.windowEnd - t.statWindowSec
            ? state.consecutive
            : 0) + 1
        : 0,
    };
  const healthy = inputsValid && state.consecutive < 2;
  return {
    healthy,
    state,
    observedAt: Math.min(data.observedAt, read.metricAt),
    reason: !inputsValid
      ? "evidence-unavailable"
      : healthy
        ? "healthy"
        : "production-threshold",
  };
}

/** Query the documented Better Stack metrics schema, using only validated identifiers. */
export async function queryReadEvidence(
  endpoint: string,
  username: string,
  password: string,
  t: SupervisorTarget,
  now = Date.now(),
  request = fetch,
): Promise<ReadEvidence> {
  secureEndpoint(endpoint);
  // Revalidate all interpolated SQL identifiers even for programmatic callers.
  if (
    !/^t[0-9]+_[a-zA-Z0-9_]+_metrics$/.test(t.source) ||
    ![t.deviceId, t.readerId].every((x) => /^[a-f0-9-]{36}$/i.test(x)) ||
    !["liveone", "liveone-usher"].includes(t.service) ||
    !["fronius", "deepsea", "selectronic", "sigenergy"].includes(t.vendor)
  )
    throw Error("Invalid metric query identity");
  if (
    !username ||
    !password ||
    !Number.isInteger(t.statWindowSec) ||
    t.statWindowSec < 900 ||
    t.statWindowSec > 21600
  )
    throw Error("Invalid metric query configuration");
  const end =
    Math.floor((now / 1000 - 120) / t.statWindowSec) * t.statWindowSec;
  const filter = `label('service') = '${t.service}' AND label('environment') = 'production' AND label('vendor') = '${t.vendor}' AND label('device.id') = '${t.deviceId}' AND label('reader.id') = '${t.readerId}'`;
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const query = async (sql: string) => {
    const value = await boundedJSON(
      await request(endpoint, {
        method: "POST",
        headers: { authorization: auth, "content-type": "text/plain" },
        body: sql + " FORMAT JSON",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      }),
    );
    return z
      .object({ data: z.array(z.record(z.string(), z.unknown())).max(16) })
      .parse(value).data;
  };
  // Histogram counts are stored as deltas by Better Stack. Sum those deltas, not
  // cumulative SDK snapshots. Backend ingestion/reset semantics must be verified first.
  const stats = await query(
    `SELECT sumMerge(bucket_count) AS samples, sumMergeIf(bucket_count, label('outcome') IN ('partial','error')) AS failures, histogramQuantile(0.95) AS p95Sec FROM remote(${t.source}) WHERE ${filter} AND name = 'liveone.read.duration' AND label('outcome') IN ('success','partial','error') AND dt >= toDateTime(${end - t.statWindowSec}) AND dt < toDateTime(${end})`,
  );
  const gauges = await query(
    `SELECT name, maxMerge(value_max) AS value, toUnixTimestamp(max(dt)) AS observedAt FROM remote(${t.source}) WHERE ${filter} AND name IN ('liveone.read.last_started','liveone.read.last_completed','liveone.read.last_success') AND dt >= toDateTime(${Math.floor(now / 1000) - 120}) AND dt <= toDateTime(${Math.floor(now / 1000)}) GROUP BY name`,
  );
  const numeric = z
    .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/)])
    .transform(Number)
    .pipe(z.number().finite());
  const row = z
    .object({
      samples: numeric.pipe(z.number().int().nonnegative()),
      failures: numeric.pipe(z.number().int().nonnegative()),
      p95Sec: numeric.pipe(z.number().nonnegative()),
    })
    .parse(stats.length === 1 ? stats[0] : null);
  const parsed = z
    .array(
      z.object({
        name: z.enum([
          "liveone.read.last_started",
          "liveone.read.last_completed",
          "liveone.read.last_success",
        ]),
        value: z.coerce.number().positive(),
        observedAt: z.coerce.number().positive(),
      }),
    )
    .length(3)
    .parse(gauges);
  if (new Set(parsed.map((x) => x.name)).size !== 3)
    throw Error("Missing reader timestamps");
  return {
    ...row,
    asOf: now / 1000,
    windowEnd: end,
    metricAt: Math.min(...parsed.map((x) => x.observedAt)),
    lastSuccess: parsed.find((x) => x.name === "liveone.read.last_success")!
      .value,
  };
}

export function createSupervisionMetrics(meter: Meter) {
  const states = new Map<
    string,
    { revision: number; policyId: string; healthy: boolean; at: number }
  >();
  for (const [name, key] of [
    ["healthy", "healthy"],
    ["evidence_at", "at"],
  ] as const)
    meter
      .createObservableGauge(`liveone.trial.supervision.${name}`, {
        unit: key === "at" ? "s" : "1",
      })
      .addCallback((obs) => {
        for (const [poller, s] of states)
          if (key === "healthy" || s.at > 0)
            obs.observe(Number(s[key]), {
              service: "liveone-trial-supervisor",
              environment: "production",
              "poller.id": poller,
              revision: s.revision,
              "policy.id": s.policyId,
            });
      });
  return (
    poller: string,
    revision: number,
    policyId: string,
    healthy: boolean,
    at: number,
  ) => {
    if (states.size >= 64 && !states.has(poller))
      throw Error("Supervision series budget exceeded");
    states.set(poller, { revision, policyId, healthy, at });
  };
}
