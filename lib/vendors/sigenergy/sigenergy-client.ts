/**
 * Sigenergy (mySigen) cloud API client.
 *
 * Reverse-engineered cloud path (the mySigen app backend), driven purely by the owner's
 * username + password. Verified end-to-end against a live Australian account via the CLI proof
 * (`scripts/sigenergy/poll.ts`). Dependency-free — Node's built-in `node:crypto` + native `fetch`.
 *
 * Auth: legacy OAuth password grant. `POST {api-<region>}/auth/oauth/token`, HTTP Basic `sigen:sigen`,
 * password AES-128-CBC(key=iv="sigensigensigenp")+base64. Returns access + refresh tokens (~12h).
 * A newer plain-JSON OpenAPI path exists but the legacy path is what the live account authenticates
 * with, so it is the default; `authMode` can force either.
 */

import { createCipheriv, createHash } from "node:crypto";
import type {
  SigenRegion,
  SigenergyDayEnergy,
  SigenergyEnergyFlow,
  SigenergyEnergyInterval,
  SigenergyEnergyTotals,
  SigenergyStationInfo,
} from "./types";

const UA = "liveone/1.0";

// AES-128-CBC constants — key and IV are BOTH the literal 16-byte ASCII string "sigensigensigenp".
const SIGEN_AES_KEY = Buffer.from("sigensigensigenp", "utf8");
const SIGEN_AES_IV = Buffer.from("sigensigensigenp", "utf8");
// Hardcoded OAuth client for the legacy token endpoint → base64("sigen:sigen").
const OAUTH_BASIC =
  "Basic " + Buffer.from("sigen:sigen", "utf8").toString("base64");

const legacyBase = (region: SigenRegion) =>
  `https://api-${region}.sigencloud.com`;
const openapiBase = (region: SigenRegion) =>
  `https://openapi-${region}.sigencloud.com`;

export type SigenAuthMode = "legacy" | "openapi" | "auto";
type ResolvedAuthMode = "legacy" | "openapi";

export type SigenergyErrorKind =
  | "auth"
  | "rate-limit"
  | "http"
  | "shape"
  | "network";

/** Typed error so the adapter can distinguish bad-creds from throttling from transport faults. */
export class SigenergyError extends Error {
  constructor(
    message: string,
    readonly kind: SigenergyErrorKind,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SigenergyError";
  }
}

interface SigenToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  authMode: ResolvedAuthMode;
}

export interface SigenergyClientOptions {
  username: string;
  password: string;
  region?: SigenRegion;
  authMode?: SigenAuthMode;
}

/** Encrypt a plaintext password the way the mySigen client does before the legacy login. */
export function encryptPassword(plain: string): string {
  const cipher = createCipheriv("aes-128-cbc", SIGEN_AES_KEY, SIGEN_AES_IV);
  cipher.setAutoPadding(true); // PKCS7
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

function pickNumber(obj: unknown, keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/** The statistics endpoint sometimes returns `data` as a JSON-encoded string — re-parse if so. */
function maybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Extract the six energy fields (kWh) from a statistics record or an itemList row. */
function extractEnergyTotals(rec: unknown): SigenergyEnergyTotals {
  return {
    powerGeneration: pickNumber(rec, ["powerGeneration"]),
    powerUse: pickNumber(rec, ["powerUse"]),
    powerToGrid: pickNumber(rec, ["powerToGrid"]),
    powerFromGrid: pickNumber(rec, ["powerFromGrid"]),
    esCharging: pickNumber(rec, ["esCharging"]),
    esDischarging: pickNumber(rec, ["esDischarging"]),
  };
}

/**
 * Extract the station's commissioning / "open" DAY (local, "YYYY-MM-DD") from a station-info record.
 * Prefers the explicit `stationOpenTime` ("YYYY-MM-DD"); falls back to `stationComponentStatsEnabledTime`
 * ("YYYYMMDD HH:MM:SS") then the SN-embedded date (`10`+`YYYYMMDD`+`NNNNN`). Returns undefined if none parse.
 */
function extractStationOpenDate(
  d: Record<string, unknown>,
): string | undefined {
  const iso = (s: string) =>
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const plausible = (ymd: string) => {
    const y = +ymd.slice(0, 4),
      m = +ymd.slice(4, 6),
      dd = +ymd.slice(6, 8);
    return y >= 2015 && y <= 2100 && m >= 1 && m <= 12 && dd >= 1 && dd <= 31;
  };
  const open = d.stationOpenTime;
  if (typeof open === "string" && /^\d{4}-\d{2}-\d{2}$/.test(open)) return open;
  const enabled = d.stationComponentStatsEnabledTime;
  if (typeof enabled === "string") {
    const s = enabled.replace(/\D/g, "").slice(0, 8);
    if (s.length === 8 && plausible(s)) return iso(s);
  }
  const sn = String(d.stationSnCode ?? d.stationId ?? "");
  if (/^\d{15}$/.test(sn) && plausible(sn.slice(2, 10)))
    return iso(sn.slice(2, 10));
  return undefined;
}

export class SigenergyClient {
  private readonly username: string;
  private readonly password: string;
  private readonly region: SigenRegion;
  private readonly authMode: SigenAuthMode;
  private token: SigenToken | null = null;
  // Stable per-account device id (a real phone sends a constant one). Reused across every login and
  // refresh so we present as one device rather than a brand-new one on each call / serverless cold start.
  private readonly deviceId: string;

  constructor(opts: SigenergyClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.region = opts.region ?? "aus";
    this.authMode = opts.authMode ?? "legacy";
    this.deviceId = createHash("sha256")
      .update(`liveone:${this.username}:${this.region}`)
      .digest("hex")
      .slice(0, 32);
  }

  /** Shared fetch wrapper that maps HTTP + API-level status into typed SigenergyErrors. */
  private async apiFetch(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new SigenergyError(
        `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    const code =
      json && typeof json === "object" && "code" in json
        ? Number((json as Record<string, unknown>).code)
        : undefined;
    const msg =
      json && typeof json === "object" && "msg" in json
        ? String((json as Record<string, unknown>).msg)
        : undefined;

    if (res.status === 429 || code === 1110) {
      throw new SigenergyError(
        `Rate limited (HTTP ${res.status}${code != null ? `, code ${code}` : ""})`,
        "rate-limit",
        res.status,
        json ?? text,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new SigenergyError(
        `Auth failed (HTTP ${res.status})`,
        "auth",
        res.status,
        json ?? text,
      );
    }
    if (!res.ok) {
      throw new SigenergyError(
        `HTTP ${res.status}: ${text.slice(0, 300)}`,
        "http",
        res.status,
        json ?? text,
      );
    }
    if (code != null && code !== 0) {
      throw new SigenergyError(
        `Sigenergy API error code ${code}${msg ? ` (${msg})` : ""}`,
        "http",
        res.status,
        json,
      );
    }
    return json ?? text;
  }

  /** GET wrapper that retries transient faults (network / HTTP 5xx) with a short backoff. */
  private async apiGet(url: string, retries = 2): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.apiFetch(url, { headers: this.authHeaders() });
      } catch (err) {
        const transient =
          err instanceof SigenergyError &&
          (err.kind === "network" ||
            (err.kind === "http" && (err.status ?? 0) >= 500));
        if (!transient || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }

  private unwrap(json: unknown): Record<string, unknown> {
    if (json && typeof json === "object" && "data" in json) {
      return (json as Record<string, unknown>).data as Record<string, unknown>;
    }
    return (json ?? {}) as Record<string, unknown>;
  }

  private async loginLegacy(): Promise<SigenToken> {
    const body = new URLSearchParams({
      grant_type: "password",
      username: this.username,
      password: encryptPassword(this.password),
      scope: "server",
      userDeviceId: this.deviceId,
    });
    const json = await this.apiFetch(
      `${legacyBase(this.region)}/auth/oauth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: OAUTH_BASIC,
          "User-Agent": UA,
        },
        body,
      },
    );
    const d = this.unwrap(json);
    const accessToken = (d.access_token ?? d.accessToken) as string | undefined;
    if (!accessToken) {
      throw new SigenergyError(
        "Legacy login returned no access_token",
        "shape",
        undefined,
        json,
      );
    }
    const expiresIn = Number(d.expires_in ?? d.expiresIn ?? 0);
    return {
      accessToken,
      refreshToken: (d.refresh_token ?? d.refreshToken) as string | undefined,
      expiresAt:
        Date.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
      authMode: "legacy",
    };
  }

  private async loginOpenapi(): Promise<SigenToken> {
    const json = await this.apiFetch(
      `${openapiBase(this.region)}/openapi/auth/login/password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
        }),
      },
    );
    const d = this.unwrap(json);
    const accessToken = (d.accessToken ?? d.access_token) as string | undefined;
    if (!accessToken) {
      throw new SigenergyError(
        "OpenAPI login returned no accessToken",
        "shape",
        undefined,
        json,
      );
    }
    const expiresIn = Number(d.expiresIn ?? d.expires_in ?? 0);
    return {
      accessToken,
      refreshToken: (d.refreshToken ?? d.refresh_token) as string | undefined,
      expiresAt:
        Date.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
      authMode: "openapi",
    };
  }

  private async login(): Promise<SigenToken> {
    const modes: ResolvedAuthMode[] =
      this.authMode === "openapi"
        ? ["openapi"]
        : this.authMode === "auto"
          ? ["legacy", "openapi"]
          : ["legacy"];
    let lastErr: unknown;
    for (const mode of modes) {
      try {
        const token =
          mode === "legacy"
            ? await this.loginLegacy()
            : await this.loginOpenapi();
        this.token = token;
        return token;
      } catch (err) {
        lastErr = err;
        if (err instanceof SigenergyError && err.kind === "auth") break; // same creds fail on both
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new SigenergyError("All auth modes failed", "auth");
  }

  private async refresh(): Promise<SigenToken> {
    if (!this.token) return this.login();
    if (this.token.authMode !== "legacy" || !this.token.refreshToken)
      return this.login();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token.refreshToken,
      userDeviceId: this.deviceId,
    });
    try {
      const json = await this.apiFetch(
        `${legacyBase(this.region)}/auth/oauth/token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: OAUTH_BASIC,
            "User-Agent": UA,
          },
          body,
        },
      );
      const d = this.unwrap(json);
      const accessToken = (d.access_token ?? d.accessToken) as
        | string
        | undefined;
      if (!accessToken) return this.login();
      const expiresIn = Number(d.expires_in ?? d.expiresIn ?? 0);
      this.token = {
        accessToken,
        refreshToken:
          (d.refresh_token as string | undefined) ?? this.token.refreshToken,
        expiresAt:
          Date.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
        authMode: "legacy",
      };
      return this.token;
    } catch {
      return this.login();
    }
  }

  /** Ensure a valid token, refreshing when within 5 min of expiry. */
  private async ensureToken(): Promise<SigenToken> {
    if (!this.token) return this.login();
    if (Date.now() >= this.token.expiresAt - 5 * 60 * 1000)
      return this.refresh();
    return this.token;
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) throw new SigenergyError("Not authenticated", "auth");
    return {
      Authorization: `Bearer ${this.token.accessToken}`,
      "Content-Type": "application/json",
      lang: "en_US",
      "auth-client-id": "sigen",
      "User-Agent": UA,
    };
  }

  /** Fetch the owner's station and normalize the fields we provision a LiveOne system from. */
  async getStation(): Promise<SigenergyStationInfo> {
    await this.ensureToken();
    const url =
      this.token!.authMode === "legacy"
        ? `${legacyBase(this.region)}/device/owner/station/home`
        : `${openapiBase(this.region)}/openapi/system`;
    const json = await this.apiGet(url);
    const raw = this.unwrap(json);
    const d = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
    const id = d.stationId ?? d.id ?? d.stationSnCode ?? d.systemId;
    return {
      stationId: id != null ? String(id) : "",
      name: (d.stationName ?? d.stationShowName ?? d.name) as
        | string
        | undefined,
      timeZoneName: d.timeZoneName as string | undefined,
      openDate: extractStationOpenDate(d),
      pvCapacityKw: pickNumber(d, ["pvCapacity"]),
      batteryCapacityKwh: pickNumber(d, ["batteryCapacity"]),
      latitude: pickNumber(d, ["latitude"]),
      longitude: pickNumber(d, ["longitude"]),
      hasAcCharger: Boolean(d.hasAcCharger),
      acSnList: Array.isArray(d.acSnList)
        ? (d.acSnList as string[])
        : undefined,
      raw: json,
    };
  }

  /** Fetch the real-time energy flow for a station and extract the headline metrics (kW / %). */
  async getEnergyFlow(stationId: string): Promise<SigenergyEnergyFlow> {
    await this.ensureToken();
    const url =
      this.token!.authMode === "legacy"
        ? `${legacyBase(this.region)}/device/sigen/station/energyflow?id=${encodeURIComponent(stationId)}`
        : `${openapiBase(this.region)}/openapi/systems/${encodeURIComponent(stationId)}/energyFlow?systemId=${encodeURIComponent(stationId)}`;
    const json = await this.apiGet(url);
    const d = this.unwrap(json);
    return {
      pvKw: pickNumber(d, ["pvPower", "pv_power", "solarPower"]),
      batteryKw: pickNumber(d, [
        "batteryPower",
        "essPower",
        "batteryChargeDischargePower",
      ]),
      // Grid is reported as `buySellPower` (+buy/import, −sell/export).
      gridKw: pickNumber(d, ["buySellPower", "gridPower", "gridActivePower"]),
      loadKw: pickNumber(d, ["loadPower", "consumptionPower"]),
      // DC chargers report `evPower`; AC chargers report `acPower`.
      evKw: pickNumber(d, ["evPower", "acPower", "evsePower", "chargerPower"]),
      batterySoc: pickNumber(d, ["batterySoc", "soc", "batterySOC"]),
      raw: json,
    };
  }

  /**
   * Fetch one day's ENERGY STATISTICS (legacy app API). READ-ONLY.
   *
   * `GET /data-process/sigen/station/statistics/energy` with `dateFlag=1` returns the day's kWh totals
   * plus a 5-minute `itemList` whose energy fields are cumulative-since-local-midnight kWh counters.
   * `dateFlag=1` expects `startDate == endDate` (a multi-day span returns zeros — verified), so callers
   * loop day-by-day. The collector (`statistics.ts`) differences the counters into interval energy.
   */
  async getEnergyStatistics(
    stationId: string,
    date: string, // YYYYMMDD
    dateFlag = 1,
  ): Promise<SigenergyDayEnergy> {
    await this.ensureToken();
    if (this.token!.authMode !== "legacy") {
      throw new SigenergyError(
        "getEnergyStatistics requires legacy auth (no confirmed openapi per-day endpoint)",
        "shape",
      );
    }
    const url =
      `${legacyBase(this.region)}/data-process/sigen/station/statistics/energy` +
      `?stationId=${encodeURIComponent(stationId)}` +
      `&startDate=${encodeURIComponent(date)}` +
      `&endDate=${encodeURIComponent(date)}` +
      `&dateFlag=${dateFlag}` +
      `&fulfill=false`;
    const json = await this.apiGet(url);
    const d = maybeJson(this.unwrap(json)) as Record<string, unknown>;
    const totals = extractEnergyTotals(d);
    const rawList = Array.isArray(d.itemList) ? d.itemList : [];
    const intervals: SigenergyEnergyInterval[] = rawList
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        dataTime: String(r.dataTime ?? ""),
        ...extractEnergyTotals(r),
      }));
    return { date, totals, intervals, raw: json };
  }
}
