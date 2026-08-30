/**
 * Remote generator run control — the handler logic behind
 * `app/api/usher/control/[siteId]/run/route.ts` (kept out of the route file so jest can import it
 * without Next's `@/` alias, which the root jest config maps to the wrong package).
 *
 * POST starts/extends/stops a supervised run, GET reports status.
 *
 *   POST { passkey, runtimeSec, overrideRemoteStart? }   runtimeSec: 0 releases our latch
 *   GET  (passkey via the x-usher-passkey header)
 *
 * Layered auth, outermost first:
 *  1. Cloudflare Access at the edge (the tunnel is the only public path to this server) — the
 *     control policy admits only the LiveOne service token, not browser sessions.
 *  2. The Cf-Access-Jwt-Assertion JWT is RE-VERIFIED here (aud + signature against the team's
 *     certs) when CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set — so "only LiveOne can control"
 *     holds at the origin even if an Access policy is misconfigured or the server ever binds
 *     beyond loopback (the WG hub routes traffic from both site LANs).
 *  3. The per-device passkey (usher.yaml `control.passkeyEnv`), timing-safe-compared. Resolved
 *     LAZILY: a missing secret degrades this route to a 503 — it must never brick the collector.
 *
 * The route is deliberately thin: every control decision (validation, pre-flight, ownership,
 * persistence, the deadline) lives in core/control.ts's RunSupervisor. Supervisors are looked up in
 * the globalThis-backed registry — the run loop lives in the instrumentation bundle, this handler in
 * the route bundle, and the registry is the one object both can see.
 */

import { timingSafeEqual, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { registry } from "../state/registry";
import type { RunSupervisor } from "./control";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let warnedNoAccessCheck = false;

/** Verify the Access JWT when configured; a misconfigured edge must not be the only gate. */
async function verifyAccessJwt(req: Request): Promise<string | null> {
  // Read the env lazily: like the passkey, Access config must be a per-request concern.
  const ACCESS_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN; // e.g. "myteam.cloudflareaccess.com"
  const ACCESS_AUD = process.env.CF_ACCESS_AUD;
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    if (!warnedNoAccessCheck) {
      warnedNoAccessCheck = true;
      console.warn(
        "[control] CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD unset — origin-side Access JWT verification is OFF (edge policy + passkey only)",
      );
    }
    return null; // not configured → skip (the passkey still gates)
  }
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return "missing Cf-Access-Jwt-Assertion header";
  try {
    jwks ??= createRemoteJWKSet(
      new URL(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
    );
    await jwtVerify(token, jwks, {
      issuer: `https://${ACCESS_TEAM_DOMAIN}`,
      audience: ACCESS_AUD,
    });
    return null;
  } catch (e) {
    return `Access JWT rejected: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Constant-time passkey check (compare digests so length differences don't shortcut). */
function passkeyMatches(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Auth + lookup shared by POST and GET. Returns the supervisor or a ready-to-send error response.
 * Unknown site and control-not-configured are BOTH 404 — no capability disclosure.
 */
async function authorize(
  req: Request,
  siteId: string,
  suppliedPasskey: string | undefined,
): Promise<{ supervisor: RunSupervisor } | { response: Response }> {
  const jwtError = await verifyAccessJwt(req);
  if (jwtError) {
    return { response: Response.json({ error: jwtError }, { status: 401 }) };
  }

  const supervisor = registry.supervisors.get(siteId);
  if (!supervisor) {
    return { response: Response.json({ error: "not found" }, { status: 404 }) };
  }

  // Lazy passkey resolution — the whole point: a missing secret is a 503 here, not a dead collector.
  const expected = process.env[supervisor.passkeyEnv];
  if (!expected) {
    console.error(
      `[control] passkey env ${supervisor.passkeyEnv} is not set — control unavailable for ${siteId}`,
    );
    return {
      response: Response.json(
        { error: "control passkey is not configured on this hub" },
        { status: 503 },
      ),
    };
  }
  if (!suppliedPasskey || !passkeyMatches(suppliedPasskey, expected)) {
    return {
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return { supervisor };
}

export async function handleRunPost(
  req: Request,
  siteId: string,
): Promise<Response> {
  let body: {
    passkey?: unknown;
    runtimeSec?: unknown;
    overrideRemoteStart?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "malformed JSON body" }, { status: 400 });
  }

  const auth = await authorize(
    req,
    siteId,
    typeof body.passkey === "string" ? body.passkey : undefined,
  );
  if ("response" in auth) return auth.response;

  if (typeof body.runtimeSec !== "number") {
    return Response.json(
      { error: "runtimeSec (number, seconds; 0 to stop) is required" },
      { status: 400 },
    );
  }

  const versionBefore = auth.supervisor.stateVersion;
  const result = await auth.supervisor.request(body.runtimeSec, {
    overrideRemoteStart: body.overrideRemoteStart === true,
  });
  // Tick NOW rather than at the next boundary, so the command reaches LiveOne on the press instead
  // of up to a poll period later. Gated on the version actually moving: a REFUSED command changed
  // nothing, and waking for it would spend a Modbus round-trip to re-send what we already sent.
  // Covers the ambiguous start and the failed stop too — both bump.
  if (auth.supervisor.stateVersion !== versionBefore) {
    registry.entries.find((e) => e.source.siteId === siteId)?.wake?.();
  }
  const { ok, status, ...rest } = result;
  return Response.json(
    { ok, ...rest, status: auth.supervisor.status() },
    { status },
  );
}

/**
 * `probe` — the safe end-to-end read. Same auth, same supervisor, same device mutex, same Modbus
 * path as a real run; FC3 reads only. Use it to prove the chain works after a deploy, or before
 * committing to a run, without any possibility of moving the engine.
 *
 * Takes no `runtimeSec`: a probe asks about the MOMENT, and the cap it would be measured against is
 * in the answer as `maxRuntimeSec`. See `RunSupervisor.probe()`.
 *
 * The body IS the probe result — one flat object, passed through untouched. The HTTP status is the
 * only thing derived here, and it is derived from `ok`, which is false for exactly one reason: the
 * controller could not be read.
 */
export async function handleProbePost(
  req: Request,
  siteId: string,
): Promise<Response> {
  let body: { passkey?: unknown } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return Response.json({ error: "malformed JSON body" }, { status: 400 });
  }

  const auth = await authorize(
    req,
    siteId,
    typeof body.passkey === "string"
      ? body.passkey
      : (req.headers.get("x-usher-passkey") ?? undefined),
  );
  if ("response" in auth) return auth.response;

  const result = await auth.supervisor.probe();
  return Response.json(result, { status: result.ok ? 200 : 503 });
}

export async function handleRunGet(
  req: Request,
  siteId: string,
): Promise<Response> {
  const auth = await authorize(
    req,
    siteId,
    req.headers.get("x-usher-passkey") ?? undefined,
  );
  if ("response" in auth) return auth.response;
  return Response.json(auth.supervisor.status());
}
