/**
 * OpenElectricity v4 HTTP client.
 *
 * One app-wide API key is read from `OPEN_ELECTRICITY_API_KEY` (set in Vercel for
 * prod/preview/dev). All requests are `Authorization: Bearer <key>`.
 *
 * Shared by the live adapter, the online backfill downloader, and the offline bulk
 * ingestor — keep this the single place that knows the endpoint shapes + auth.
 */

import type {
  NemRegion,
  OeEndpoint,
  OeInterval,
  OeMeResponse,
  OeMetric,
  OeNetworkResponse,
  OeRateLimit,
} from "./types";

const BASE_URL = "https://api.openelectricity.org.au/v4";
const DEFAULT_NETWORK = "NEM";

/**
 * Error thrown for non-2xx responses. `retryable` is true for 429 / 5xx so backfill
 * and bulk callers know to back off and retry; `resetEpochSec` carries the rate-limit
 * reset (or Retry-After) when present.
 */
export class OpenElectricityApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly resetEpochSec?: number,
  ) {
    super(message);
    this.name = "OpenElectricityApiError";
  }
}

export function getApiKey(): string {
  const key = process.env.OPEN_ELECTRICITY_API_KEY;
  if (!key) {
    throw new Error(
      "OPEN_ELECTRICITY_API_KEY is not set (required for the OpenElectricity integration)",
    );
  }
  return key;
}

/**
 * Energy basis for the emissions-intensity computation. At 5m the API serves no native
 * `energy`, so we use `power` (MW) and derive energy = power × intervalHours; at coarser
 * intervals `energy` (MWh) is served directly. Mirrors the OE frontend's `getBasisMetric`.
 */
export function getBasisMetric(interval: OeInterval): "power" | "energy" {
  return interval === "5m" ? "power" : "energy";
}

/**
 * OpenElectricity requires **timezone-naive datetimes in network time** for date_start/date_end
 * (it 400s on a tz-aware `Z` value). NEM = AEST (UTC+10, no DST), so shift the UTC instant by
 * +10h and format the wall-clock with no offset suffix, e.g. "2026-05-14T21:15:00".
 * (WEM would be AWST/UTC+8 — not handled; all current regions are NEM.)
 */
const NETWORK_OFFSET_MIN = 600; // AEST

function toApiDateTime(date: Date): string {
  const local = new Date(date.getTime() + NETWORK_OFFSET_MIN * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}`
  );
}

function parseRateLimit(res: Response): OeRateLimit | null {
  const limit =
    res.headers.get("x-ratelimit-limit") ?? res.headers.get("ratelimit-limit");
  const remaining =
    res.headers.get("x-ratelimit-remaining") ??
    res.headers.get("ratelimit-remaining");
  const reset =
    res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset");
  if (limit == null && remaining == null) return null;
  return {
    limit: Number(limit ?? 0),
    remaining: Number(remaining ?? 0),
    reset: Number(reset ?? 0),
  };
}

export interface FetchNetworkArgs {
  region: NemRegion;
  metrics: OeMetric[];
  dateStart: Date;
  dateEnd: Date;
  interval?: OeInterval;
  networkCode?: string;
  apiKey?: string;
}

async function fetchSeries(
  endpoint: OeEndpoint,
  args: FetchNetworkArgs,
): Promise<{ response: OeNetworkResponse; rateLimit: OeRateLimit | null }> {
  const apiKey = args.apiKey ?? getApiKey();
  const network = args.networkCode ?? DEFAULT_NETWORK;
  const interval = args.interval ?? "5m";

  const params = new URLSearchParams();
  for (const m of args.metrics) params.append("metrics", m);
  params.set("interval", interval);
  params.set("primary_grouping", "network_region");
  params.set("network_region", args.region);
  params.set("date_start", toApiDateTime(args.dateStart));
  params.set("date_end", toApiDateTime(args.dateEnd));

  const url = `${BASE_URL}/${endpoint}/network/${network}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  const rateLimit = parseRateLimit(res);

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const resetEpochSec =
      rateLimit?.reset || (retryAfter ? Number(retryAfter) : undefined);
    throw new OpenElectricityApiError(
      `OpenElectricity rate limit exceeded (${endpoint})`,
      429,
      true,
      resetEpochSec,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OpenElectricityApiError(
      `OpenElectricity ${endpoint} API error (${res.status}): ${text}`,
      res.status,
      res.status >= 500,
    );
  }

  const response = (await res.json()) as OeNetworkResponse;
  return { response, rateLimit };
}

/** GET /v4/data/network/{network} — `power`, `emissions`, `energy`, … */
export function fetchNetworkData(args: FetchNetworkArgs) {
  return fetchSeries("data", args);
}

/** GET /v4/market/network/{network} — `price`, `renewable_proportion`, … */
export function fetchMarketData(args: FetchNetworkArgs) {
  return fetchSeries("market", args);
}

/** GET /v4/me — validates the key and returns the current rate-limit window. */
export async function fetchMe(
  apiKey: string = getApiKey(),
): Promise<OeMeResponse> {
  const res = await fetch(`${BASE_URL}/me`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new OpenElectricityApiError(
      `OpenElectricity /me error (${res.status})`,
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
  const json = (await res.json()) as { data?: OeMeResponse } & OeMeResponse;
  return (json?.data ?? json) as OeMeResponse;
}
