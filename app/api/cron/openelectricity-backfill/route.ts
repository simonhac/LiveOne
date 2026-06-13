import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { parseDateISO, calendarDateToUnixRange } from "@/lib/date-utils";
import { backfillRange } from "@/lib/vendors/openelectricity/backfill";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";

// 1d aggregation over a multi-day range can take a while; give the route headroom.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const AEST_OFFSET_MIN = 600;
const MAX_RANGE_DAYS = 31; // beyond this, use the offline bulk ingestor

/**
 * Bounded online backfill for an OpenElectricity region.
 *
 * Lives under /api/cron/* (a Clerk-public prefix) so it is reachable by an
 * `Authorization: Bearer $CRON_SECRET` curl — `/api/admin/*` is gated by Clerk's edge
 * middleware before the handler runs. `requireCronOrAdmin` also accepts an admin session.
 *
 * Body: { region: "NSW1", start: "YYYY-MM-DD", end: "YYYY-MM-DD", dryRun?: boolean }
 * (start/end are inclusive AEST calendar dates.)
 *
 *   curl -X POST .../api/cron/openelectricity-backfill \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -d '{"region":"NSW1","start":"2026-06-01","end":"2026-06-10","dryRun":true}'
 */
export async function POST(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: {
    region?: string;
    start?: string;
    end?: string;
    dryRun?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { region, start, end, dryRun = false } = body;

  if (!region || !isNemRegion(region)) {
    return NextResponse.json(
      { error: `Invalid or missing region (expected a NEM region): ${region}` },
      { status: 400 },
    );
  }
  if (!start || !end) {
    return NextResponse.json(
      { error: "start and end (YYYY-MM-DD) are required" },
      { status: 400 },
    );
  }

  let startCal;
  let endCal;
  try {
    startCal = parseDateISO(start);
    endCal = parseDateISO(end);
  } catch {
    return NextResponse.json(
      { error: "start/end must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (endCal.compare(startCal) < 0) {
    return NextResponse.json(
      { error: "end must be on or after start" },
      { status: 400 },
    );
  }
  if (endCal.compare(startCal) + 1 > MAX_RANGE_DAYS) {
    return NextResponse.json(
      {
        error: `Range exceeds ${MAX_RANGE_DAYS} days; use the offline bulk ingestor (scripts/openelectricity-bulk-ingest.ts) for large loads`,
      },
      { status: 400 },
    );
  }

  // Resolve the region's system.
  const sm = SystemsManager.getInstance();
  const systems = await sm.getActiveSystems();
  const system = systems.find(
    (s) => s.vendorType === "openelectricity" && s.vendorSiteId === region,
  );
  if (!system) {
    return NextResponse.json(
      { error: `No active openelectricity system for region ${region}` },
      { status: 404 },
    );
  }

  // Inclusive end-of-day: the end calendar date's day end.
  const [startSec] = calendarDateToUnixRange(startCal, AEST_OFFSET_MIN);
  const [, endSec] = calendarDateToUnixRange(endCal, AEST_OFFSET_MIN);
  const dateStart = new Date(startSec * 1000);
  const dateEnd = new Date(endSec * 1000);

  const session = await sessionManager.createSession({
    sessionLabel: "oe-backfill",
    systemId: system.id,
    cause: dryRun ? "ADMIN-DRYRUN" : "ADMIN",
    started: new Date(),
  });
  const collector = createPollCollector();
  const startTime = Date.now();

  try {
    const result = await backfillRange({
      systemId: system.id,
      region,
      network: (system.metadata as { network?: string } | null)?.network,
      dateStart,
      dateEnd,
      session,
      collector,
      dryRun,
      aggregate: dryRun ? null : { start: startCal, end: endCal },
    });

    await sessionManager.updateSessionResult(
      session.id,
      {
        duration: Date.now() - startTime,
        successful: result.errors.length === 0,
        error: result.errors.length ? result.errors.join("; ") : null,
        numRows: result.intervalsIngested,
        response: result,
      },
      collector.observations,
    );

    return NextResponse.json({
      ok: result.errors.length === 0,
      systemId: system.id,
      sessionId: session.id,
      dryRun,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sessionManager.updateSessionResult(
      session.id,
      {
        duration: Date.now() - startTime,
        successful: false,
        error: message,
        numRows: 0,
      },
      collector.observations,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
