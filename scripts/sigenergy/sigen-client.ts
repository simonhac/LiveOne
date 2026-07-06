/**
 * Reverse-engineered Sigenergy (mySigen) cloud API client.
 *
 * Portable and dependency-free — uses only Node's built-in `node:crypto` and native `fetch`.
 * Written for the CLI proof (`scripts/sigenergy/poll.ts`) but deliberately self-contained so it
 * can later graduate into `lib/vendors/sigenergy/sigenergy-client.ts` for the LiveOne integration.
 *
 * Two auth variants are supported (the CLI can force one or auto-fall-back and report which works):
 *   - "legacy"  → POST {api-<region>}/auth/oauth/token, HTTP Basic `sigen:sigen`, form
 *                 grant_type=password, password AES-128-CBC(key=iv="sigensigensigenp")+base64.
 *                 Returns access + refresh tokens.
 *   - "openapi" → POST {openapi-<region>}/openapi/auth/login/password, plain JSON {username,password}.
 *                 Returns an access token (no refresh in this path → we re-login).
 *
 * All of this is community-sourced (sig-data, amber2sigen, sigen PyPI, HA integrations). The exact
 * endpoint paths and JSON field names may vary by account/firmware, so the data helpers extract
 * defensively (try several candidate keys) and always expose the raw response for inspection.
 */

import { createCipheriv } from "node:crypto";

export type SigenRegion = "aus" | "eu" | "apac" | "us" | "cn";
export type SigenAuthMode = "legacy" | "openapi" | "auto";
export type SigenResolvedAuthMode = "legacy" | "openapi";

const UA = "liveone-sigen-proof/0.1";

// AES-128-CBC constants — key and IV are BOTH the literal 16-byte ASCII string "sigensigensigenp".
const SIGEN_AES_KEY = Buffer.from("sigensigensigenp", "utf8"); // 16 bytes
const SIGEN_AES_IV = Buffer.from("sigensigensigenp", "utf8"); // 16 bytes
// Hardcoded OAuth client for the legacy token endpoint → base64("sigen:sigen") = "c2lnZW46c2lnZW4=".
const OAUTH_BASIC =
  "Basic " + Buffer.from("sigen:sigen", "utf8").toString("base64");

const legacyBase = (region: SigenRegion) =>
  `https://api-${region}.sigencloud.com`;
const openapiBase = (region: SigenRegion) =>
  `https://openapi-${region}.sigencloud.com`;

/** Encrypt a plaintext password the way the mySigen web/app client does before the legacy login. */
export function encryptPassword(plain: string): string {
  const cipher = createCipheriv("aes-128-cbc", SIGEN_AES_KEY, SIGEN_AES_IV);
  cipher.setAutoPadding(true); // PKCS7
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return encrypted.toString("base64");
}

export type SigenErrorKind =
  | "auth"
  | "rate-limit"
  | "http"
  | "shape"
  | "network";

/** Typed error so the CLI/adapter can distinguish bad-creds from throttling from transport faults. */
export class SigenError extends Error {
  constructor(
    message: string,
    readonly kind: SigenErrorKind,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SigenError";
  }
}

export interface SigenToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  authMode: SigenResolvedAuthMode;
}

export interface SigenStation {
  stationId: string | null;
  name?: string;
  raw: unknown;
}

export interface SigenEnergyFlow {
  /** Instantaneous power values, as returned by the API (Sigenergy documents these in kW). */
  pv: number | null;
  battery: number | null; // vendor sign: +charge / −discharge (confirm empirically)
  grid: number | null; // vendor sign: +import / −export (confirm empirically)
  load: number | null;
  ev: number | null;
  batterySoc: number | null; // %
  raw: unknown;
}

export interface SigenClientOptions {
  username: string;
  password: string;
  region?: SigenRegion; // default "aus"
  authMode?: SigenAuthMode; // default "auto"
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Pull the first numeric value found among candidate keys (handles camelCase/snake_case variants). */
function pickNumber(obj: unknown, keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/** Best-effort station-id extraction from a home/station/system response of unknown shape. */
function extractStationId(data: unknown): string | null {
  if (data == null) return null;
  const candidate = Array.isArray(data) ? data[0] : data;
  if (!candidate || typeof candidate !== "object") return null;
  const rec = candidate as Record<string, unknown>;
  const nested = rec.stationInfo as Record<string, unknown> | undefined;
  const id =
    rec.id ??
    rec.stationId ??
    rec.systemId ??
    rec.stationCode ??
    (nested ? (nested.id ?? nested.stationId) : undefined);
  return id != null ? String(id) : null;
}

export class SigenClient {
  private readonly username: string;
  private readonly password: string;
  private readonly region: SigenRegion;
  private readonly authMode: SigenAuthMode;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private token: SigenToken | null = null;

  constructor(opts: SigenClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.region = opts.region ?? "aus";
    this.authMode = opts.authMode ?? "auto";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  getToken(): SigenToken | null {
    return this.token;
  }

  /** Shared fetch wrapper that maps HTTP + API-level status into typed SigenErrors. */
  private async apiFetch(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new SigenError(
        `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined; // non-JSON body
    }

    const code =
      json && typeof json === "object" && "code" in json
        ? Number((json as Record<string, unknown>).code)
        : undefined;
    const msg =
      json && typeof json === "object" && "msg" in json
        ? String((json as Record<string, unknown>).msg)
        : undefined;

    // Rate limiting: HTTP 429 or API code 1110.
    if (res.status === 429 || code === 1110) {
      throw new SigenError(
        `Rate limited by Sigenergy (HTTP ${res.status}${code != null ? `, code ${code}` : ""}) at ${url}`,
        "rate-limit",
        res.status,
        json ?? text,
      );
    }
    // Auth failure.
    if (res.status === 401 || res.status === 403) {
      throw new SigenError(
        `Auth failed (HTTP ${res.status}) at ${url}`,
        "auth",
        res.status,
        json ?? text,
      );
    }
    // Other transport errors.
    if (!res.ok) {
      throw new SigenError(
        `HTTP ${res.status} at ${url}: ${text.slice(0, 300)}`,
        "http",
        res.status,
        json ?? text,
      );
    }
    // API-level error with a 200 envelope ({code, msg, data}); code 0 == success.
    if (code != null && code !== 0) {
      throw new SigenError(
        `Sigenergy API error code ${code}${msg ? ` (${msg})` : ""} at ${url}`,
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
          err instanceof SigenError &&
          (err.kind === "network" ||
            (err.kind === "http" && (err.status ?? 0) >= 500));
        if (!transient || attempt >= retries) throw err;
        const backoff = 800 * (attempt + 1);
        this.log(
          `   transient ${err instanceof SigenError ? err.kind : "error"} — retrying in ${backoff}ms…`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private unwrap(json: unknown): unknown {
    if (json && typeof json === "object" && "data" in json) {
      return (json as Record<string, unknown>).data;
    }
    return json;
  }

  private async loginLegacy(): Promise<SigenToken> {
    const body = new URLSearchParams({
      grant_type: "password",
      username: this.username,
      password: encryptPassword(this.password),
      scope: "server",
      userDeviceId: String(this.now()),
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
    // OAuth tokens may sit at the top level OR under a `data` envelope — handle both.
    const d = this.unwrap(json) as Record<string, unknown>;
    const accessToken = (d?.access_token ?? d?.accessToken) as
      | string
      | undefined;
    if (!accessToken) {
      throw new SigenError(
        "Legacy login returned no access_token",
        "shape",
        undefined,
        json,
      );
    }
    const expiresIn = Number(d?.expires_in ?? d?.expiresIn ?? 0);
    return {
      accessToken,
      refreshToken: (d?.refresh_token ?? d?.refreshToken) as string | undefined,
      expiresAt:
        this.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
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
    const d = this.unwrap(json) as Record<string, unknown>;
    const accessToken = (d?.accessToken ?? d?.access_token) as
      | string
      | undefined;
    if (!accessToken) {
      throw new SigenError(
        "OpenAPI login returned no accessToken",
        "shape",
        undefined,
        json,
      );
    }
    const expiresIn = Number(d?.expiresIn ?? d?.expires_in ?? 0);
    return {
      accessToken,
      refreshToken: (d?.refreshToken ?? d?.refresh_token) as string | undefined,
      expiresAt:
        this.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
      authMode: "openapi",
    };
  }

  /** Log in, honouring the configured authMode (auto tries legacy then openapi). */
  async login(): Promise<SigenToken> {
    const modes: SigenResolvedAuthMode[] =
      this.authMode === "legacy"
        ? ["legacy"]
        : this.authMode === "openapi"
          ? ["openapi"]
          : ["legacy", "openapi"];

    let lastErr: unknown;
    for (const mode of modes) {
      try {
        this.log(`Trying auth mode "${mode}"…`);
        const token =
          mode === "legacy"
            ? await this.loginLegacy()
            : await this.loginOpenapi();
        this.token = token;
        this.log(`✅ Login OK via "${mode}"`);
        return token;
      } catch (err) {
        lastErr = err;
        const e = err instanceof SigenError ? err : null;
        this.log(
          `   auth "${mode}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Bad credentials will fail identically on both paths — no point trying the other.
        if (e?.kind === "auth") break;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new SigenError("All auth modes failed", "auth");
  }

  /** Refresh the access token (legacy uses the refresh_token grant; openapi just re-logs in). */
  async refresh(): Promise<SigenToken> {
    if (!this.token) return this.login();
    if (this.token.authMode !== "legacy" || !this.token.refreshToken) {
      return this.login();
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token.refreshToken,
      userDeviceId: String(this.now()),
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
      const d = this.unwrap(json) as Record<string, unknown>;
      const accessToken = (d?.access_token ?? d?.accessToken) as
        | string
        | undefined;
      if (!accessToken) return this.login();
      const expiresIn = Number(d?.expires_in ?? d?.expiresIn ?? 0);
      this.token = {
        accessToken,
        refreshToken: (d?.refresh_token ?? this.token.refreshToken) as
          | string
          | undefined,
        expiresAt:
          this.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
        authMode: "legacy",
      };
      return this.token;
    } catch {
      // Refresh can fail if the refresh token expired — fall back to a full login.
      return this.login();
    }
  }

  /** Ensure a valid token, refreshing when within `bufferMs` of expiry (default 5 min). */
  async ensureToken(bufferMs = 5 * 60 * 1000): Promise<SigenToken> {
    if (!this.token) return this.login();
    if (this.now() >= this.token.expiresAt - bufferMs) {
      this.log("Access token near expiry → refreshing…");
      return this.refresh();
    }
    return this.token;
  }

  private authHeaders(): Record<string, string> {
    const t = this.token;
    if (!t) throw new SigenError("Not authenticated", "auth");
    return {
      Authorization: `Bearer ${t.accessToken}`,
      "Content-Type": "application/json",
      lang: "en_US",
      "auth-client-id": "sigen",
      "User-Agent": UA,
    };
  }

  /** Fetch the owner's home/station and extract a best-effort station id. */
  async getStation(): Promise<SigenStation> {
    await this.ensureToken();
    const t = this.token!;
    const url =
      t.authMode === "legacy"
        ? `${legacyBase(this.region)}/device/owner/station/home`
        : `${openapiBase(this.region)}/openapi/system`;
    const json = await this.apiGet(url);
    const d = this.unwrap(json);
    const first = Array.isArray(d)
      ? (d[0] as Record<string, unknown>)
      : (d as Record<string, unknown>);
    const name =
      (first?.stationName as string | undefined) ??
      (first?.name as string | undefined);
    return { stationId: extractStationId(d), name, raw: json };
  }

  /** Fetch the real-time energy flow for a station and extract the headline metrics. */
  async getEnergyFlow(stationId: string): Promise<SigenEnergyFlow> {
    await this.ensureToken();
    const t = this.token!;
    const url =
      t.authMode === "legacy"
        ? `${legacyBase(this.region)}/device/sigen/station/energyflow?id=${encodeURIComponent(stationId)}`
        : `${openapiBase(this.region)}/openapi/systems/${encodeURIComponent(stationId)}/energyFlow?systemId=${encodeURIComponent(stationId)}`;
    const json = await this.apiGet(url);
    const d = this.unwrap(json);
    return {
      pv: pickNumber(d, ["pvPower", "pv_power", "solarPower", "pvActivePower"]),
      battery: pickNumber(d, [
        "batteryPower",
        "essPower",
        "bat_power",
        "batteryChargeDischargePower",
      ]),
      // Grid: the station energy-flow reports it as `buySellPower` (+buy/import, −sell/export).
      grid: pickNumber(d, [
        "buySellPower",
        "gridPower",
        "grid_power",
        "gridActivePower",
      ]),
      load: pickNumber(d, ["loadPower", "consumptionPower", "load_power"]),
      // EV: DC chargers report `evPower`; AC chargers report `acPower`.
      ev: pickNumber(d, [
        "evPower",
        "acPower",
        "evsePower",
        "chargerPower",
        "acChargerPower",
      ]),
      batterySoc: pickNumber(d, [
        "batterySoc",
        "soc",
        "batterySOC",
        "batteryStateOfCharge",
      ]),
      raw: json,
    };
  }
}
