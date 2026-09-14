/**
 * Per-device poll health, for an EXTERNAL monitor.
 *
 * `/api/health` proves the web tier and a database connection are alive. It does not prove that
 * anything is still being collected — on 2026-09-11 it would have gone green again the moment the
 * credential was restored, while the Daylesford collector stayed dead for another four hours.
 * This route answers the other question: is every device we poll still landing data?
 *
 * 200 = every active poll device is inside its budget, or is outside it for a reason its vendor
 * declared in advance. **503** = at least one is not, so a plain "expect 2xx" monitor opens an
 * incident with the offending devices in the response body. No per-device heartbeat plumbing, no
 * per-device URL storage: one monitor covers the whole fleet.
 *
 * ⚠️ `unhealthy` in the body is deliberately WIDER than what 503s — a device can be listed and the
 * status still be 200 (`device_in_maintenance`, `device_never_polled`). Read the `code`, not the
 * presence of an entry.
 *
 * 🛑 Requires `X-Health-Key`. This repo is public and site names (`sheephouse`, `kutis`, …) are
 * infrastructure detail we keep out of it; an unauthenticated version of this route would publish
 * the fleet inventory to anyone who guessed the path. BetterStack monitors send custom headers, so
 * the secret costs nothing operationally. Fail-closed: no key configured ⇒ nobody gets in.
 */

import { NextRequest, NextResponse } from "next/server";
import { planetscaleDb } from "@/lib/db/planetscale";
import {
  evaluateDeviceHealth,
  unhealthy,
  alertable,
} from "@/lib/monitoring/device-staleness";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const expected = process.env.HEALTH_CHECK_KEY;
  if (!expected) return false; // fail closed — an unset secret must not mean "open"
  const got = request.headers.get("x-health-key");
  return Boolean(got) && got === expected;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    // 404, not 401: an unauthenticated caller learns nothing about whether this route exists.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = planetscaleDb;
  if (!db) {
    return NextResponse.json(
      { status: "error", error: "database not configured" },
      { status: 503 },
    );
  }

  try {
    const all = await evaluateDeviceHealth(db);
    const bad = unhealthy(all);
    // Report everything that isn't `ok`; fail on the subset worth waking someone for. A device that
    // was added and never wired up, or one inside its vendor's declared maintenance window, appears
    // in the body — with its numbers — but does not turn the monitor red. See `alertable()`.
    const failing = alertable(all);

    return NextResponse.json(
      {
        status: failing.length === 0 ? "ok" : "degraded",
        checked: all.length,
        unhealthy: bad.map((d) => ({
          rid: d.rid,
          name: d.name,
          vendor: d.vendor,
          code: d.code,
          staleMin: d.staleMin,
          budgetMin: d.budgetMin,
          consecutiveErrors: d.consecutiveErrors,
        })),
      },
      { status: failing.length === 0 ? 200 : 503 },
    );
  } catch (e) {
    // Being unable to evaluate is a failure, not an unknown — same principle as the monitor cron.
    return NextResponse.json(
      {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }
}
