import type { Meter } from "@opentelemetry/api";
import { z } from "zod";
import { referencePage } from "../collectors/trial-artifacts";

export const observationTarget = z
  .object({
    pollerId: z.string().uuid(),
    revision: z.number().int().positive(),
    deviceId: z.string().uuid(),
    readerId: z.string().uuid(),
    pointId: z.string().uuid(),
    vendor: z.enum(["fronius", "deepsea", "selectronic", "sigenergy"]),
    cadenceSec: z
      .number()
      .int()
      .min(1)
      .max(900)
      .refine((n) => 900 % n === 0),
    liveSessionCauses: z
      .array(z.enum(["CRON", "PUSH"]))
      .min(1)
      .max(2),
  })
  .strict();
export type ObservationTarget = z.infer<typeof observationTarget>;
export interface DataObservation {
  asOf: number;
  coverage: number;
  observedAt: number;
  windowEnd: number;
  lastMeasurement?: number;
  lastReceived?: number;
}

export function secureEndpoint(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  )
    throw Error("Remote endpoints require HTTPS");
  if (url.username || url.password || url.hash) throw Error("Invalid endpoint");
  return url;
}
export async function boundedJSON(
  response: Response,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  if (!response.ok || !response.body)
    throw Error(`Observation HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw Error("Observation response exceeds budget");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

/** Successful observations only. Failed/partial pagination never produces a snapshot. */
export async function observeData(
  base: string,
  token: string,
  target: ObservationTarget,
  now = Date.now(),
  settleSec = 120,
  request = fetch,
  shutdown?: AbortSignal,
): Promise<DataObservation> {
  // Supervisor targets also contain source/policy fields; validate the observation
  // subset without rejecting the already-validated extended target.
  observationTarget.strip().parse(target);
  if (
    !token ||
    !Number.isInteger(settleSec) ||
    settleSec < 0 ||
    settleSec > 900
  )
    throw Error("Invalid observation configuration");
  const origin = secureEndpoint(base);
  const cutoff = now;
  const windowEnd = Math.floor((now - settleSec * 1000) / 900000) * 900000;
  const start = windowEnd - 900000;
  const query = {
    pollerId: target.pollerId,
    revision: String(target.revision),
    pointId: target.pointId,
    start: new Date(start).toISOString(),
    end: new Date(cutoff).toISOString(),
    asOf: new Date(cutoff).toISOString(),
    limit: "1000",
  };
  const slots = new Set<number>();
  const signal = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(shutdown ? [shutdown] : []),
  ]);
  let cursor: string | null = null,
    metadata: string | undefined,
    lastTimestamp: string | undefined;
  const result: DataObservation = {
    asOf: cutoff / 1000,
    coverage: 0,
    observedAt: 0,
    windowEnd: windowEnd / 1000,
  };
  for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
    signal.throwIfAborted();
    const url = new URL("/api/collectors/me/readings", origin);
    url.search = new URLSearchParams({
      ...query,
      ...(cursor ? { cursor } : {}),
    }).toString();
    const page = referencePage.parse(
      await boundedJSON(
        await request(url, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal,
        }),
      ),
    );
    if (
      page.deviceId !== target.deviceId ||
      page.pollerId !== target.pollerId ||
      page.revision !== target.revision ||
      page.point.id !== target.pointId ||
      page.start !== query.start ||
      page.end !== query.end ||
      page.asOf !== query.asOf ||
      page.readings.length > 1000
    )
      throw Error("Observation identity/window mismatch");
    const currentMetadata = JSON.stringify(page.point);
    if (metadata && currentMetadata !== metadata)
      throw Error("Observation metadata changed");
    metadata = currentMetadata;
    for (const row of page.readings) {
      const timestamp = Date.parse(row.timestamp),
        received = Date.parse(row.receivedTime);
      if (
        timestamp < start ||
        timestamp >= cutoff ||
        Date.parse(row.createdAt) > cutoff ||
        received > cutoff ||
        (lastTimestamp && row.timestamp <= lastTimestamp)
      )
        throw Error("Observation rows out of bounds/order");
      lastTimestamp = row.timestamp;
      if (
        row.value === null ||
        !Number.isFinite(row.value) ||
        row.error ||
        row.dataQuality !== "good" ||
        !target.liveSessionCauses.includes(row.sessionCause as "CRON" | "PUSH")
      )
        continue;
      result.lastMeasurement = Math.max(
        result.lastMeasurement ?? 0,
        timestamp / 1000,
      );
      result.lastReceived = Math.max(result.lastReceived ?? 0, received / 1000);
      if (timestamp < windowEnd)
        slots.add(Math.floor((timestamp - start) / (target.cadenceSec * 1000)));
    }
    if (page.nextCursor === null) {
      result.coverage = slots.size / (900 / target.cadenceSec);
      result.observedAt = Date.now() / 1000;
      return result;
    }
    if (
      !page.readings.length ||
      page.nextCursor !== page.readings.at(-1)!.timestamp ||
      page.nextCursor === cursor
    )
      throw Error("Observation cursor did not advance");
    cursor = page.nextCursor;
  }
  throw Error("Observation page budget exceeded");
}

export function createDataMetrics(meter: Meter, environment: string) {
  const snapshots = new Map<
    string,
    { target: ObservationTarget; observation: DataObservation }
  >();
  for (const [name, key] of [
    ["last_measurement", "lastMeasurement"],
    ["last_received", "lastReceived"],
    ["coverage", "coverage"],
    ["observed_at", "observedAt"],
  ] as const) {
    meter
      .createObservableGauge(`liveone.data.${name}`, {
        unit: key === "coverage" ? "1" : "s",
      })
      .addCallback((obs) => {
        for (const { target: t, observation: o } of snapshots.values())
          if (o[key] !== undefined)
            obs.observe(o[key]!, {
              service: "liveone-trial-supervisor",
              environment,
              vendor: t.vendor,
              "device.id": t.deviceId,
              "reader.id": t.readerId,
              "point.id": t.pointId,
            });
      });
  }
  return (target: ObservationTarget, observation: DataObservation) => {
    const key = `${target.pollerId}/${target.pointId}`;
    if (!snapshots.has(key) && snapshots.size >= 512)
      throw Error("Observation series budget exceeded");
    snapshots.set(key, { target, observation });
  };
}
