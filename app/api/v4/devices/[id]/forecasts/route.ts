/**
 * `GET /api/v4/devices/{id}/forecasts` — what Amber PUBLISHED, from `amber_forecast_history`, and
 * whether the logger capturing it was alive. The operator read behind `liveone device forecasts`,
 * and the data source of `scripts/amber/forecast-accuracy.ts`, which used to need a minted prod
 * database role to answer the same questions.
 *
 * One `mode` per request:
 *   - `in-force` (default) — `start`/`end` AEST days, `channel` (repeatable; default general +
 *     feedIn), `lead` (list or range, ≤ 48 values), `anchor=end|start`. Per channel, the captured
 *     interval set and, per lead, the revision in force at each interval's cutoff.
 *   - `as-of` — `at` (ISO) and `horizon` (hours, default 48): the curve as published at `at`, every
 *     channel including `site` (spot, renewables).
 *   - `health` — `start`/`end`: polls vs captures, horizon, gaps attributed against `sessions`, and
 *     a per channel × type breakdown.
 *
 * An in-force read is bounded by `MAX_IN_FORCE_ROWS` (interval × lead rows, all channels): 413 when
 * the captured set times the leads would exceed it — see the constant for why.
 *
 * 422 for a non-Amber device: nothing else writes the table, and an empty answer would read as
 * "the logger is dead" rather than "wrong device".
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { Device } from "@/lib/ids";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import {
  InForceTooLarge,
  readAsOf,
  readCaptureHealth,
  readInForce,
} from "@/lib/vendors/amber/forecast-store";
import {
  FORECAST_CHANNELS,
  MAX_IN_FORCE_ROWS,
} from "@/lib/vendors/amber/forecast-wire";
import { parseLeads } from "@/lib/vendors/amber/forecast-accuracy";

export const maxDuration = 60;

const DAY_MS = 86_400_000;
/** Two months — the longest window the accuracy analysis has wanted, and a bound on 48 lead scans. */
const MAX_WINDOW_DAYS = 62;
const MAX_LEADS = 48;
const MAX_HORIZON_HOURS = 72;
const DEFAULT_CHANNELS = ["general", "feedIn"];

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/**
 * `start`/`end` are AEST calendar days (fixed +10, no DST — Amber's `nemTime` basis), inclusive.
 * Returns the UTC window `[00:00 start, 00:00 end+1)`.
 */
function aestWindow(
  start: string | null,
  end: string | null,
): { fromMs: number; toMs: number } | string {
  if (!start || !end) return "start and end are required (YYYY-MM-DD, AEST)";
  const fromMs = Date.parse(`${start}T00:00:00+10:00`);
  const endMs = Date.parse(`${end}T00:00:00+10:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    !Number.isFinite(fromMs) ||
    !Number.isFinite(endMs) ||
    // `Date.parse` rolls 2026-02-30 over to 2 March; a round trip catches it.
    new Date(fromMs + 10 * 3_600_000).toISOString().slice(0, 10) !== start ||
    new Date(endMs + 10 * 3_600_000).toISOString().slice(0, 10) !== end
  )
    return "start and end must be real YYYY-MM-DD days";
  if (endMs < fromMs) return `start (${start}) is after end (${end})`;
  const days = Math.round((endMs - fromMs) / DAY_MS) + 1;
  if (days > MAX_WINDOW_DAYS)
    return `window is ${days} days; the maximum is ${MAX_WINDOW_DAYS}`;
  return { fromMs, toMs: endMs + DAY_MS };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDeviceParam(params);
  if ("error" in resolved) return resolved.error;
  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;
  if (auth.device.vendorType !== "amber")
    return NextResponse.json(
      {
        error: `forecasts exist only for Amber devices (this one is '${auth.device.vendorType}')`,
      },
      { status: 422 },
    );

  const sp = request.nextUrl.searchParams;
  const mode = sp.get("mode") ?? "in-force";
  const base = {
    ok: true,
    deviceId: Device.encode(resolved.uuid),
    systemId: resolved.systemId,
    mode,
  };
  const headers = { "Cache-Control": "private, no-store" };

  if (mode === "as-of") {
    const atMs = Date.parse(sp.get("at") ?? "");
    if (!Number.isFinite(atMs)) return bad("as-of needs at=<ISO timestamp>");
    const horizon = Number(sp.get("horizon") ?? 48);
    if (!(horizon > 0 && horizon <= MAX_HORIZON_HOURS))
      return bad(`horizon must be in (0, ${MAX_HORIZON_HOURS}] hours`);
    const rows = await readAsOf({
      deviceRid: resolved.systemId,
      atMs,
      horizonHours: horizon,
    });
    return NextResponse.json(
      { ...base, at: new Date(atMs).toISOString(), horizon, rows },
      { headers },
    );
  }

  if (mode !== "in-force" && mode !== "health")
    return bad("mode must be in-force, as-of or health");

  const window = aestWindow(sp.get("start"), sp.get("end"));
  if (typeof window === "string") return bad(window);
  const windowOut = {
    start: sp.get("start"),
    end: sp.get("end"),
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
  };

  if (mode === "health") {
    const health = await readCaptureHealth({
      deviceRid: resolved.systemId,
      ...window,
      nowMs: Date.now(),
    });
    return NextResponse.json(
      { ...base, window: windowOut, health },
      { headers },
    );
  }

  const channels = sp.getAll("channel").flatMap((c) => c.split(","));
  const selected = channels.length ? channels : DEFAULT_CHANNELS;
  const unknown = selected.filter(
    (c) => !(FORECAST_CHANNELS as readonly string[]).includes(c),
  );
  if (unknown.length)
    return bad(
      `unknown channel ${unknown.join(", ")} (expected ${FORECAST_CHANNELS.join(", ")})`,
    );

  let leads: number[];
  try {
    leads = parseLeads(sp.getAll("lead").join(",") || "1-12");
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
  if (leads.length === 0) return bad("lead must list positive hours");
  if (leads.length > MAX_LEADS)
    return bad(`${leads.length} leads requested; the maximum is ${MAX_LEADS}`);

  const anchor = sp.get("anchor") ?? "end";
  if (anchor !== "end" && anchor !== "start")
    return bad("anchor must be end or start");

  // One budget across every channel in the request — see MAX_IN_FORCE_ROWS for why it exists.
  const out = [];
  let budget = MAX_IN_FORCE_ROWS;
  try {
    for (const channel of [...new Set(selected)]) {
      const read = await readInForce({
        deviceRid: resolved.systemId,
        channel,
        ...window,
        leads,
        anchor,
        maxRows: budget,
      });
      budget -= read.captured.length * leads.length;
      out.push(read);
    }
  } catch (e) {
    if (e instanceof InForceTooLarge)
      return NextResponse.json(
        { error: e.message, maxRows: MAX_IN_FORCE_ROWS },
        { status: 413 },
      );
    throw e;
  }
  return NextResponse.json(
    { ...base, window: windowOut, anchor, leads, channels: out },
    { headers },
  );
}
