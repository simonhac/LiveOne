import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { deviceRunPeriods } from "@/lib/db/planetscale/schema";
import { formatInTimezone } from "@/lib/date-utils";
import { RUN_TRACKING } from "@/lib/run-tracking/flags";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 366; // hard upper bound — this endpoint is always bounded

/** kW (1dp) magnitude of a signed Watt value, mirroring the legacy generator-events rounding. */
function magnitudeKw(w: number | null): number {
  if (w == null) return 0;
  return Math.round(Math.abs(w) / 100) / 10;
}

/**
 * GET /api/system/{systemId}/run-periods?role=generator&period=30d
 *
 * Bounded, indexed read of persisted device run periods. The open (NULL end_time) period renders
 * as "running now". Replaces the unbounded + N+1 generator-events hack. For role=generator the
 * response is shaped to the legacy { events, totalEnergyKwh } contract for back-compat, plus
 * richer fields (ISO times, duration, avg power) for future generalisation.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);
    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role") || "generator";

    // Flag off → behave like "no events" (legacy-compatible empty payload).
    if (!RUN_TRACKING) {
      return NextResponse.json({
        events: [],
        totalEnergyKwh: 0,
        running: false,
      });
    }

    // Bounded range: period=Nd (default 30d), or explicit start/end (ISO or YYYY-MM-DD).
    const nowMs = Date.now();
    let rangeStartMs: number;
    let rangeEndMs = nowMs;
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");
    if (startParam || endParam) {
      if (!startParam || !endParam) {
        return NextResponse.json(
          { error: "Both start and end must be provided together" },
          { status: 400 },
        );
      }
      const s = Date.parse(startParam);
      const e = Date.parse(endParam);
      if (isNaN(s) || isNaN(e)) {
        return NextResponse.json(
          { error: "Invalid start/end (expected ISO or YYYY-MM-DD)" },
          { status: 400 },
        );
      }
      rangeStartMs = s;
      rangeEndMs = e;
    } else {
      const period = searchParams.get("period") || `${DEFAULT_PERIOD_DAYS}d`;
      let days = parseInt(period.replace("d", ""), 10);
      if (isNaN(days) || days <= 0) days = DEFAULT_PERIOD_DAYS;
      if (days > MAX_PERIOD_DAYS) days = MAX_PERIOD_DAYS;
      rangeStartMs = nowMs - days * DAY_MS;
    }

    const tz = authResult.system.displayTimezone;

    // A period is in range if it starts at/before the range end and is open or ends at/after start.
    const rows = await requirePlanetscaleDb()
      .select()
      .from(deviceRunPeriods)
      .where(
        and(
          eq(deviceRunPeriods.systemId, systemId),
          eq(deviceRunPeriods.role, role),
          lte(deviceRunPeriods.startTime, new Date(rangeEndMs)),
          or(
            isNull(deviceRunPeriods.endTime),
            gte(deviceRunPeriods.endTime, new Date(rangeStartMs)),
          ),
        ),
      )
      .orderBy(asc(deviceRunPeriods.startTime));

    let runningNow = false;
    let totalEnergyKwh = 0;
    const events = rows.map((r) => {
      const running = r.endTime === null;
      if (running) runningNow = true;
      const energyKwh = r.energyKwh ?? 0;
      totalEnergyKwh += energyKwh;
      return {
        // Legacy generator-events contract:
        date: formatInTimezone(r.startTime, tz, "d MMM"),
        startTime: formatInTimezone(r.startTime, tz, "HH:mm"),
        endTime: r.endTime ? formatInTimezone(r.endTime, tz, "HH:mm") : null,
        running,
        minPowerKw: magnitudeKw(r.maxPowerW), // magnitude min = |max signed|
        maxPowerKw: magnitudeKw(r.minPowerW), // magnitude max = |min signed|
        energyKwh,
        // Richer fields for future generalisation:
        startTimeISO: r.startTime.toISOString(),
        endTimeISO: r.endTime ? r.endTime.toISOString() : null,
        durationSeconds: r.durationSeconds,
        avgPowerW: r.avgPowerW,
        sampleCount: r.sampleCount,
      };
    });

    return NextResponse.json({
      role,
      events,
      totalEnergyKwh: Math.round(totalEnergyKwh * 1000) / 1000,
      running: runningNow,
    });
  } catch (error) {
    console.error("Error fetching run periods:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
