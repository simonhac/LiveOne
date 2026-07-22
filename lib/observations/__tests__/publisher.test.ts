import { describe, it, expect } from "@jest/globals";
import { buildObservations } from "../publisher";
import type { SystemWithPolling } from "@/lib/systems-manager";

/**
 * Regression guard for the observations ms-truncation bug: buildObservations must
 * serialize measurementTime/receivedTime with millisecond precision so the QStash
 * payload (and therefore PG point_readings) keeps sub-second precision, matching
 * the legacy inline write. See lib/date-utils.ts formatTime_fromJSDate(includeMillis).
 */
describe("buildObservations", () => {
  const system = {
    id: 6,
    vendorType: "mondo",
    vendorSiteId: "site-1",
    timezoneOffsetMin: 600,
  } as unknown as SystemWithPolling;

  const point = {
    index: 1,
    pointUid: "0192f000-0000-7000-8000-0000000000aa",
    physicalPathTail: "mp/energyNowW",
    metricType: "power",
    metricUnit: "W",
    displayName: "Solar",
  } as never;

  it("serializes measurementTime/receivedTime with lossless millisecond precision", () => {
    const measurementTimeMs = 1749081599611; // …:59.611
    const receivedTimeMs = 1749081596775; // …:56.775

    const [obs] = buildObservations(system, [
      {
        sessionId: "s1",
        point,
        value: 0,
        measurementTimeMs,
        receivedTimeMs,
        interval: "raw",
      },
    ]);

    // Both timestamps carry .mmm before the timezone offset...
    expect(obs.measurementTime).toMatch(/\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(obs.receivedTime).toMatch(/\.\d{3}[+-]\d{2}:\d{2}$/);
    // ...and round-trip back to the exact epoch-ms (no precision lost on the queue).
    expect(new Date(obs.measurementTime).getTime()).toBe(measurementTimeMs);
    expect(new Date(obs.receivedTime).getTime()).toBe(receivedTimeMs);
  });

  it("carries the point's pointUid on the payload (v2, for the DAO-seam receiver)", () => {
    const [obs] = buildObservations(system, [
      {
        sessionId: "s1",
        point,
        value: 0,
        measurementTimeMs: 1749081599611,
        receivedTimeMs: 1749081596775,
        interval: "raw",
      },
    ]);

    expect(obs.pointUid).toBe("0192f000-0000-7000-8000-0000000000aa");
    // The legacy reference grammar is still emitted (dual-grammar back-compat).
    expect(obs.debug?.reference).toBe("6.1");
  });
});
