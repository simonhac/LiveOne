/**
 * Client for the usher hub's generator control API (`packages/usher`, deployed as
 * `liveone-flyhub`). This is the ONLY thing in the web app that talks to the control plane on the
 * hub; `control.ts` turns a point action into one of these calls.
 *
 * Why a hub at all: the DSE's control keys are momentary and parameterless — Telemetry Start is a
 * LATCH the engine runs behind until it is cleared, and the module cannot be configured over
 * Modbus (DSE case #00739597). So "run for N minutes" is necessarily *someone holding the latch
 * and letting go later*, and that someone must be always-on and restart-survivable. Vercel
 * functions are neither. The hub owns the deadline (absolute instant, persisted, doubly enforced);
 * this client only ever *asks*, and a request that never arrives simply means no run.
 *
 * Transport auth is two independent credentials, and they live in deliberately different places:
 *  - a Cloudflare Access **service token** (`CF-Access-Client-Id/Secret`) in ENV, because it is a
 *    property of this DEPLOYMENT — how the app reaches the hub at all — not of any device. The
 *    hub publishes no public HTTP; everything goes through the cloudflared tunnel behind Access,
 *    and Vercel's egress IPs are dynamic so an IP allowlist is not an option. Directly analogous
 *    to `TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`.
 *  - the **per-device passkey**, passed in by the caller, which resolves it from the DEVICE
 *    OWNER's Clerk credentials (see ./control.ts). It is a per-device secret like a Selectronic
 *    password or a Tesla refresh token, so it lives where those live — never in env, which would
 *    make it a property of the deployment and let any device on it command the generator.
 */

import { ControlDispatchError } from "@/lib/control/errors";
import type { StructuredMessage } from "@/lib/control/message-format";

/** Default hub origin; override per-environment with USHER_CONTROL_URL. */
const DEFAULT_HUB_URL = "https://usher.liveone.energy";

export interface HubRunResult {
  ok: boolean;
  action?: "started" | "extended" | "released";
  reason?: string;
  /** `reason` unrendered, when it names an instant. Absent from a hub older than the ICU change;
   *  `reason` is always populated, so a caller may prefer this and fall back without branching. */
  reasonMessage?: StructuredMessage;
  stopAt: string | null;
  remainingSec: number | null;
  released?: boolean;
  stillRunning?: string | null;
}

/**
 * The hub's `noop` body — see `handleNoopPost` in packages/usher/core/control-api.ts, which
 * spreads the supervisor's own `noop()` result and appends `hypotheticalRuntimeSec` +
 * `controlStatus`. Kept structurally in step with that handler: this interface is the contract
 * between two deployables, so a field added there is only usable once it is added here.
 */
export interface HubNoopResult {
  /** False ⇒ the hub could not READ the controller; `verdict` explains. Never means "refused". */
  ok: boolean;
  /** The hub's own answer, from the same `gateStart()` a real request consults. */
  wouldStart?: boolean;
  verdict: string;
  /** `verdict` unrendered — see `reasonMessage`. Only the already-latched verdict names an instant,
   *  so this is absent for every other outcome and the flat `verdict` is the answer. */
  verdictMessage?: StructuredMessage;
  /** Absent when `ok` is false — there was no successful read to report. */
  preflight?: {
    ownership: {
      /** reg 772: 0 Stop, 1 Auto, 2 Manual…; null = read n/a */
      mode: number | null;
      modeName: string | null;
      /** the SP-PRO's demand on configurable digital input A */
      remoteStartInput: "closed" | "open" | "unknown";
      running: boolean;
    };
    /** Which System Control Functions the module advertises (SCF map 4096–4103). */
    scfSupported: {
      selectAuto: boolean;
      telemetryStart: boolean;
      telemetryCancel: boolean;
    };
    scfMap: number[];
  };
  /** Echo of the runtime the verdict was computed FOR. */
  hypotheticalRuntimeSec?: number;
  /** The supervisor's live state — the authoritative deadline, and the only `maxRuntimeSec` that
   *  is actually enforced (the point's `control` descriptor is a separate, independent bound). */
  controlStatus?: {
    latched: boolean;
    state: string;
    stopAt: string | null;
    remainingSec: number | null;
    requestedAt: string | null;
    lastCommandAt: string | null;
    lastError: string | null;
    maxRuntimeSec: number;
  };
}

function hubUrl(): string {
  return (process.env.USHER_CONTROL_URL ?? DEFAULT_HUB_URL).replace(/\/$/, "");
}

/**
 * The DEPLOYMENT's transport credentials. Read at CALL time, not module load — a module-level
 * const is untestable and misbehaves on a serverless cold start with late-injected env (the same
 * reasoning as Tesla's `hasFleetApiConfig`).
 *
 * Optional by design: absent, we send no Access headers, so a developer can point
 * `USHER_CONTROL_URL` at a hub reachable without the tunnel. In production their absence simply
 * means Cloudflare answers 403 before the hub ever sees the request — fail-closed at the edge.
 */
function accessHeaders(): Record<string, string> {
  const id = process.env.USHER_CF_ACCESS_CLIENT_ID;
  const secret = process.env.USHER_CF_ACCESS_CLIENT_SECRET;
  return id && secret
    ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }
    : {};
}

async function call<T>(
  siteId: string,
  passkey: string,
  path: "run" | "noop",
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const url = `${hubUrl()}/api/usher/control/${encodeURIComponent(siteId)}/${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...accessHeaders(),
      },
      body: JSON.stringify({ ...body, passkey }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    // 🛑 A timeout here is AMBIGUOUS for a start: the hub may have received the request and
    // latched the engine with only the response lost. Never report this as "nothing happened" —
    // the hub's own deadline still governs, so say so and let the caller check status.
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new ControlDispatchError(
      aborted
        ? `The generator hub did not respond within ${timeoutMs}ms. If this was a start, it MAY have taken effect — the hub enforces its own stop deadline; check the generator's state before retrying.`
        : `Could not reach the generator hub: ${e instanceof Error ? e.message : String(e)}`,
      503,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ControlDispatchError(
      `The generator hub returned a non-JSON ${res.status} response`,
      503,
    );
  }

  if (!res.ok) {
    // `verdict` is in the chain because the noop path answers 503 with a sentence and no
    // `reason`/`error` — "device unreachable: … — the hub could not read the controller, so a real
    // run would refuse too". That sentence IS the useful answer, and losing it to a bare
    // "HTTP 503" would turn a diagnosis into a shrug.
    const reason =
      (parsed as { reason?: string; error?: string; verdict?: string })
        .reason ??
      (parsed as { error?: string }).error ??
      (parsed as { verdict?: string }).verdict ??
      `HTTP ${res.status}`;
    // 401/403 mean OUR credentials are wrong (a deployment problem), not the user's fault.
    if (res.status === 401 || res.status === 403) {
      throw new ControlDispatchError(
        `The generator hub rejected this deployment's credentials (${res.status}). Check the Cloudflare Access service token and the control passkey.`,
        503,
      );
    }
    // ControlDispatchError's statuses are deliberately a closed set (400/404/501/503); an
    // upstream failure of any other kind is a 503 to this app's callers — the hub is what is
    // unavailable, not the request that was malformed.
    throw new ControlDispatchError(reason, res.status === 404 ? 404 : 503);
  }
  return parsed as T;
}

/**
 * Request a run of `runtimeSec` seconds; **0 releases the latch** (the hub's own semantics, passed
 * through unchanged). The hub independently caps the runtime — its `maxRuntimeSec` is a second,
 * lower ceiling than the point's control descriptor, and the two are deliberately not shared.
 */
export function hubRun(
  siteId: string,
  passkey: string,
  runtimeSec: number,
): Promise<HubRunResult> {
  return call<HubRunResult>(siteId, passkey, "run", { runtimeSec }, 20_000);
}

/** The safe probe: full chain, FC3 reads only, cannot move the engine. */
export function hubNoop(
  siteId: string,
  passkey: string,
  runtimeSec = 60,
): Promise<HubNoopResult> {
  return call<HubNoopResult>(siteId, passkey, "noop", { runtimeSec }, 15_000);
}
