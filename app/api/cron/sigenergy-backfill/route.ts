import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { getSystemCredentials } from "@/lib/secure-credentials";
import { parseDateISO } from "@/lib/date-utils";
import { aggregateRange } from "@/lib/aggregation/daily-points";
import { SigenergyClient } from "@/lib/vendors/sigenergy/sigenergy-client";
import { backfillEnergyRange } from "@/lib/vendors/sigenergy/statistics";
import type { SigenergyCredentials } from "@/lib/vendors/sigenergy/types";

// 1d aggregation over a multi-day range can take a while; give the route headroom.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 7;
const MAX_RANGE_DAYS = 31;

/**
 * Bounded backfill of Sigenergy per-5-minute ENERGY from the daily statistics endpoint (the itemList
 * cumulative counters, differenced into interval energy — see `lib/vendors/sigenergy/statistics.ts`).
 *
 * Lives under /api/cron/* (a Clerk-public prefix) so it is reachable by an
 * `Authorization: Bearer $CRON_SECRET` curl (or `x-claude: true` in dev); `requireCronOrAdmin` also
 * accepts an admin session. Writes energy 5m through the normal queue → single-writer receiver, then
 * rebuilds 1d for the range.
 *
 * Body: { systemId?: number, start?: "YYYY-MM-DD", end?: "YYYY-MM-DD", days?: number, dryRun?: boolean }
 *   - systemId: the sigenergy system; omit if there is exactly one active sigenergy system.
 *   - start/end: inclusive station-local calendar dates; if omitted, the last `days` (default 7).
 *
 *   curl -X POST .../api/cron/sigenergy-backfill \
 *     -H "Authorization: Bearer $CRON_SECRET" -d '{"days":7}'
 */
export async function POST(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: {
    systemId?: number;
    start?: string;
    end?: string;
    days?: number;
    dryRun?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { start, end, dryRun = false } = body;
  const days = Math.max(1, Math.floor(body.days ?? DEFAULT_DAYS));

  // Resolve the target sigenergy system.
  const sm = SystemsManager.getInstance();
  const sigenSystems = (await sm.getActiveSystems()).filter(
    (s) => s.vendorType === "sigenergy",
  );
  const system =
    body.systemId != null
      ? sigenSystems.find((s) => s.id === body.systemId)
      : sigenSystems.length === 1
        ? sigenSystems[0]
        : undefined;
  if (!system) {
    return NextResponse.json(
      {
        error:
          body.systemId != null
            ? `No active sigenergy system with id ${body.systemId}`
            : `Expected exactly one active sigenergy system (found ${sigenSystems.length}); pass systemId`,
      },
      { status: body.systemId != null ? 404 : 400 },
    );
  }
  if (!system.vendorSiteId) {
    return NextResponse.json(
      {
        error: `System ${system.id} has no Sigenergy station id (vendorSiteId)`,
      },
      { status: 400 },
    );
  }
  if (!system.ownerClerkUserId) {
    return NextResponse.json(
      {
        error: `System ${system.id} has no owner (needed for Sigenergy credentials)`,
      },
      { status: 400 },
    );
  }

  // Resolve the owner's mySigen credentials and build a client.
  const credentials = (await getSystemCredentials(
    system.ownerClerkUserId,
    system.id,
  )) as SigenergyCredentials | null;
  if (!credentials?.username || !credentials?.password) {
    return NextResponse.json(
      { error: `No Sigenergy credentials for system ${system.id}` },
      { status: 400 },
    );
  }

  // Resolve the station-local date range (YYYYMMDD).
  const tz = system.timezoneOffsetMin;
  const localNow = new Date(Date.now() + tz * 60 * 1000);
  const ymd = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;
  const parseToYmd = (iso: string) => iso.replace(/-/g, "");
  let startYmd: string;
  let endYmd: string;
  if (start || end) {
    endYmd = end ? parseToYmd(end) : ymd(localNow);
    startYmd = start ? parseToYmd(start) : endYmd;
  } else {
    endYmd = ymd(localNow);
    const startD = new Date(localNow);
    startD.setUTCDate(startD.getUTCDate() - (days - 1));
    startYmd = ymd(startD);
  }
  if (endYmd < startYmd) {
    return NextResponse.json(
      { error: "end must be on or after start" },
      { status: 400 },
    );
  }
  const spanDays =
    Math.round(
      (Date.UTC(
        +endYmd.slice(0, 4),
        +endYmd.slice(4, 6) - 1,
        +endYmd.slice(6, 8),
      ) -
        Date.UTC(
          +startYmd.slice(0, 4),
          +startYmd.slice(4, 6) - 1,
          +startYmd.slice(6, 8),
        )) /
        (24 * 60 * 60 * 1000),
    ) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Range ${spanDays}d exceeds ${MAX_RANGE_DAYS}d cap` },
      { status: 400 },
    );
  }

  const client = new SigenergyClient({
    username: credentials.username,
    password: credentials.password,
    region: credentials.region ?? "aus",
  });

  const session = await sessionManager.createSession({
    sessionLabel: "sigen-energy-backfill",
    systemId: system.id,
    cause: dryRun ? "ADMIN-DRYRUN" : "ADMIN",
    started: new Date(),
  });
  const collector = createPollCollector();
  const startTime = Date.now();

  try {
    const result = await backfillEnergyRange({
      client,
      systemId: system.id,
      stationId: system.vendorSiteId,
      startDate: startYmd,
      endDate: endYmd,
      tzOffsetMin: tz,
      session,
      collector,
    });

    // Flush the collected observations to the queue on session close (unless dry run).
    await sessionManager.updateSessionResult(
      session.id,
      {
        duration: Date.now() - startTime,
        successful: result.errors.length === 0,
        error: result.errors.length ? result.errors.join("; ") : null,
        numRows: result.days.reduce((a, d) => a + d.readingsWritten, 0),
        response: result,
      },
      dryRun ? [] : collector.observations,
    );

    // Rebuild 1d aggregates for the touched range from the freshly-landed 5m.
    let aggregated1d = false;
    if (!dryRun && result.errors.length === 0) {
      const toIso = (y: string) =>
        `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
      await aggregateRange(
        parseDateISO(toIso(startYmd)),
        parseDateISO(toIso(endYmd)),
      );
      aggregated1d = true;
    }

    return NextResponse.json({
      ok: result.errors.length === 0,
      systemId: system.id,
      sessionId: session.id,
      dryRun,
      range: { start: startYmd, end: endYmd },
      aggregated1d,
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
      dryRun ? [] : collector.observations,
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
