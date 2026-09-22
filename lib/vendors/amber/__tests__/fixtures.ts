/**
 * Shared Amber `/prices` record fixtures for the forecast-history and price-batch tests.
 */
import type { AmberPriceRecord } from "../types";

export const NEM_TIME = "2026-08-14T18:30:00+10:00";
export const NEM_TIME_MS = new Date(NEM_TIME).getTime();

/** A general-channel ForecastInterval ending at {@link NEM_TIME}; override any field. */
export function forecastRecord(
  overrides: Partial<AmberPriceRecord> = {},
): AmberPriceRecord {
  return {
    type: "ForecastInterval",
    date: "2026-08-14",
    duration: 30,
    startTime: "2026-08-14T08:00:00Z",
    endTime: "2026-08-14T08:30:00Z",
    nemTime: NEM_TIME,
    perKwh: 32.5,
    renewables: 41.2,
    spotPerKwh: 12.3,
    channelType: "general",
    spikeStatus: "none",
    descriptor: "neutral",
    ...overrides,
  };
}
