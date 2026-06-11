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
});
