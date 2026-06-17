/**
 * OpenElectricity (opennem) API types.
 *
 * The v4 API (https://api.openelectricity.org.au/v4) serves Australian NEM/WEM market
 * data. We consume three regional signals at 5-minute resolution:
 *   - emissions intensity (tCO2e/MWh) — COMPUTED from `emissions` ÷ energy (no native metric)
 *   - spot price ($/MWh)              — `price` metric (market endpoint)
 *   - renewable proportion (%)        — `renewable_proportion` metric (market endpoint)
 *   - operational demand (MW)         — `demand` metric (market endpoint)
 *
 * Two endpoints are involved (no single endpoint serves all the metrics we need):
 *   - /v4/data/network/{network}   → power, emissions (+ energy, market_value, storage_battery)
 *   - /v4/market/network/{network} → price, renewable_proportion (+ demand, curtailment, …)
 *
 * Response timestamps are the interval START (ClickHouse toStartOfFiveMinute, [start,end) window),
 * so callers convert to liveone's interval-END convention via `intervalEnd = startTs + interval`.
 */

/** NEM regions (the eastern-states dispatch regions). */
export type NemRegion = "NSW1" | "QLD1" | "VIC1" | "SA1" | "TAS1";

export const NEM_REGIONS: readonly NemRegion[] = [
  "NSW1",
  "QLD1",
  "VIC1",
  "SA1",
  "TAS1",
];

export function isNemRegion(value: string): value is NemRegion {
  return (NEM_REGIONS as readonly string[]).includes(value);
}

/** Metrics served by /v4/data/network/{network}. */
export type OeDataMetric = "power" | "energy" | "emissions";
/** Metrics served by /v4/market/network/{network}. */
export type OeMarketMetric = "price" | "renewable_proportion" | "demand";
export type OeMetric = OeDataMetric | OeMarketMetric;

export type OeEndpoint = "data" | "market";

/** Bucket sizes we use. The API supports more, but liveone only stores 5m natively. */
export type OeInterval = "5m" | "1h" | "1d";

export interface OpenElectricityCredentials {
  apiKey: string;
}

/** A single `[startTimestampISO, value]` tuple within a result series. */
export type OeDataPoint = [string, number | null];

export interface OeResult {
  name: string;
  columns?: Record<string, string>;
  data: OeDataPoint[];
}

export interface OeSeries {
  /** e.g. "power", "emissions", "price", "renewable_proportion" */
  metric: string;
  unit: string;
  results?: OeResult[];
}

export interface OeNetworkResponse {
  version?: string;
  created_at?: string;
  success: boolean;
  error?: string | null;
  data: OeSeries[];
  total_records?: number;
}

export interface OeRateLimit {
  limit: number;
  remaining: number;
  reset: number;
}

export interface OeMeResponse {
  rate_limit?: OeRateLimit;
  [key: string]: unknown;
}
