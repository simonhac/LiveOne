import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices,
  derivedIntervals,
  points,
  type DerivedInterval,
} from "@/lib/db/planetscale/schema";
import {
  getRunDetectorForHandleRole,
  type ResolvedRunDetector,
} from "@/lib/derivations/resolve";
import { Point, type PointId } from "@/lib/ids";
import { resolvePointDisplay } from "@/lib/point/display/registry";
import { getUnitDisplay } from "@/lib/point/unit-display";
import {
  avgPowerWFromEnergy,
  planRunPeriodColumns,
  type RunPeriodColumns,
  type RunSignalMeta,
} from "@/lib/run-tracking/run-period-view";
import { roundToThree } from "@/lib/history/format-opennem";
import { formatInTimezone } from "@/lib/date-utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 366; // hard upper bound — this endpoint is always bounded
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

/** Fallback number format when the display registry doesn't cover the signal point. */
const DEFAULT_SIGNAL_FORMAT = "0.0";

/**
 * A provenance total that knows what it covers.
 *
 * Two rules, both load-bearing. It stays **null** until some run actually contributes, so a period
 * with no priced runs shows a blank footer cell rather than "$0.00". And it tracks `knownKwh` — the
 * energy of just the runs that carried a figure — because a window can straddle the moment
 * provenance was switched on, and a total that silently covers 7 of 12 runs while the Energy total
 * covers all 12 invites exactly the wrong division (cost ÷ energy ⇒ a c/kWh well under the real
 * tariff). The client compares `knownKwh` against the period energy and marks the total as partial.
 */
function knownSum() {
  let total: number | null = null;
  let knownKwh = 0;
  return {
    add(value: number | null | undefined, energyKwh: number) {
      if (value == null) return;
      total = (total ?? 0) + value;
      knownKwh += energyKwh;
    },
    total: () => roundToThree(total),
    knownKwh: () => roundToThree(knownKwh) ?? 0,
  };
}

/**
 * Describe the signal a detector follows, so its statistics can be shown in their OWN unit rather
 * than assumed to be Watts. One uuid-keyed `point_info` read (joined to `systems` for the
 * `vendorType` the display registry keys on) — same pattern as `listEnabledHwsModels`.
 *
 * A missing `points` row is survivable: warn and return null, and the caller simply omits the
 * signal column (never a 500).
 */
async function readSignalMeta(
  signalPoint: PointId,
): Promise<RunSignalMeta | null> {
  const uuid = Point.toUuid(signalPoint);
  const [row] = await requirePlanetscaleDb()
    .select({
      displayName: points.name,
      metricType: points.metricType,
      metricUnit: points.unit,
      subsystem: points.subsystem,
      physicalPathTail: points.physicalPath,
      vendorType: devices.vendor,
    })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(eq(points.id, uuid))
    .limit(1);
  if (!row) {
    console.warn(
      `[RunPeriods] signal point ${uuid} has no points row — omitting the signal column`,
    );
    return null;
  }
  // The registry wins where it covers the point (e.g. deepsea generator engine_rpm -> rpm / "0");
  // otherwise fall back to the RAW unit spelling. Deliberately NOT getContextualUnitDisplay, which
  // maps metric_type 'power' to "kW" WITHOUT scaling the value — the same mislabel in a new coat.
  const display = resolvePointDisplay(
    row.vendorType,
    row.subsystem,
    row.physicalPathTail,
  );
  return {
    label: row.displayName,
    metricType: row.metricType,
    metricUnit: row.metricUnit,
    unit: display?.unit ?? getUnitDisplay(row.metricUnit),
    format: display?.format ?? DEFAULT_SIGNAL_FORMAT,
  };
}

/** Everything a row needs that is constant across the request. */
interface EventShape {
  tz: string;
  columns: RunPeriodColumns;
  /** The detector's CURRENT version — rows written by an older one may be in a different unit. */
  detectorVersion: number | null;
}

/**
 * The run's end date, but only when it falls on a DIFFERENT local day than the start — the merged
 * "when" column prints it exactly then, so a midnight-crossing run can't read as a same-day range.
 */
function endDateIfDifferentDay(r: DerivedInterval, tz: string): string | null {
  if (!r.endTime) return null;
  const startDay = formatInTimezone(r.startTime, tz, "EEE d MMM");
  const endDay = formatInTimezone(r.endTime, tz, "EEE d MMM");
  return endDay === startDay ? null : endDay;
}

/** Shape one derived interval into the (legacy-compatible + enriched) event the UI consumes. */
function toEvent(r: DerivedInterval, s: EventShape) {
  // `avg_power_w` holds a statistic of the RAW SIGNAL, whose unit is whatever the detector's signal
  // point measures. A row written by an EARLIER detector version predates a signal/config change, so
  // its unit is not provably the one `signal` describes (Daylesford's pre-2026-07-11 rows are
  // Selectronic Watts; its current rows are DSE rpm). Suppress rather than mislabel.
  const unitProven =
    s.detectorVersion != null && r.detectorVersion === s.detectorVersion;
  const avgSignal = unitProven ? r.avgPowerW : null;
  return {
    // Legacy generator-events contract:
    date: formatInTimezone(r.startTime, s.tz, "EEE d MMM"),
    startTime: formatInTimezone(r.startTime, s.tz, "HH:mm"),
    endTime: r.endTime ? formatInTimezone(r.endTime, s.tz, "HH:mm") : null,
    /** Set only when the run ends on a different local day — see `endDateIfDifferentDay`. */
    endDate: endDateIfDifferentDay(r, s.tz),
    running: r.endTime === null,
    energyKwh: r.energyKwh ?? 0,
    /**
     * Accumulated at recompute time (never derived here) — see lib/run-tracking/energy.ts
     * `assignProvenanceToPeriods`. Null = unknown; the matching column is then absent entirely.
     */
    costC: r.costC,
    emissionsG: r.emissionsG,
    renewableKwh: r.renewableKwh,
    // Richer fields for cards / future generalisation:
    startTimeISO: r.startTime.toISOString(),
    endTimeISO: r.endTime ? r.endTime.toISOString() : null,
    durationSeconds: r.durationSeconds,
    sampleCount: r.sampleCount,
    /** Mean of the raw on-samples, in `signal.unit`. Null when the unit isn't provable. */
    avgSignal,
    /**
     * True average power (W). From energy ÷ duration wherever an energy point is bound; only when
     * the signal ITSELF is power (and no energy point exists) does it fall back to the signal mean,
     * where `Math.abs` is right because the figure is being presented as a magnitude.
     */
    avgPowerW:
      s.columns.avgPowerBasis === "signal"
        ? avgSignal == null
          ? null
          : Math.abs(avgSignal)
        : avgPowerWFromEnergy(r.energyKwh, r.durationSeconds),
  };
}

/**
 * Resolve the per-request signal metadata + column plan.
 *
 * The provenance columns are gated on THE ROWS, not on the site's current config. That is the only
 * gate that can't lie, because provenance is accumulated at recompute time: config says what runs
 * *would* be priced at from now on, whereas the fetched rows say what actually got stored. Gating on
 * config instead produces two symmetric failures — three empty columns after enabling
 * `generatorSource` but before a recompute has rewritten anything, and silently hidden columns over
 * rows that still hold real figures after it's unset. It also keeps the read path free of the
 * battery-binding join, and avoids having to sample a time-varying series at some arbitrary instant
 * (`Date.now()`) to decide what a whole window's worth of rows may show.
 */
async function resolveShape(
  detector: ResolvedRunDetector | null,
  tz: string,
  rows: DerivedInterval[],
): Promise<{ signal: RunSignalMeta | null; shape: EventShape }> {
  const signal = detector ? await readSignalMeta(detector.signalPoint) : null;
  const columns = planRunPeriodColumns({
    signalMetricType: signal?.metricType ?? null,
    signalMetricUnit: signal?.metricUnit ?? null,
    hasEnergyPoint: detector?.energyPoint != null,
    provenance: {
      cost: rows.some((r) => r.costC != null),
      emissions: rows.some((r) => r.emissionsG != null),
      renewable: rows.some((r) => r.renewableKwh != null),
    },
  });
  return {
    signal,
    shape: { tz, columns, detectorVersion: detector?.detectorVersion ?? null },
  };
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

    const authResult = await requireDashboardAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;

    const { searchParams } = new URL(request.url);
    const role = searchParams.get("role") || "generator";

    const tz = authResult.system.displayTimezone;
    const db = requirePlanetscaleDb();

    // The intervals hang off the run detector for this (handle, role). No detector configured →
    // no rows, which is the same empty response this endpoint has always given for an untracked
    // system. Resolved through the shared handle→area mapping so reader and writer always agree.
    const detector = await getRunDetectorForHandleRole(systemId, role);

    // Paged mode (limit present): most-recent-first, page back through ALL history. Used by the
    // dashboard generator-runs card. Bounded by limit (no time window).
    const limitParam = searchParams.get("limit");
    if (limitParam !== null) {
      const limit = Math.min(
        Math.max(parseInt(limitParam, 10) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const offset = Math.max(
        parseInt(searchParams.get("offset") || "0", 10) || 0,
        0,
      );
      // Fetch one extra to know whether an older page exists.
      const rows = detector
        ? await db
            .select()
            .from(derivedIntervals)
            .where(eq(derivedIntervals.derivationId, detector.id))
            .orderBy(desc(derivedIntervals.startTime))
            .limit(limit + 1)
            .offset(offset)
        : [];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      // Columns are planned from the rows being returned, so this page never advertises a column
      // it can't fill (see `resolveShape`).
      const { signal, shape } = await resolveShape(detector, tz, page);
      const events = page.map((r) => toEvent(r, shape));
      return NextResponse.json({
        role,
        events,
        signal,
        columns: shape.columns,
        limit,
        offset,
        hasMore,
        running: events.some((e) => e.running),
      });
    }

    // Period mode (default): a bounded time window, oldest-first, with a running total.
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

    // A period is in range if it starts at/before the range end and is open or ends at/after start.
    const rows = detector
      ? await db
          .select()
          .from(derivedIntervals)
          .where(
            and(
              eq(derivedIntervals.derivationId, detector.id),
              lte(derivedIntervals.startTime, new Date(rangeEndMs)),
              or(
                isNull(derivedIntervals.endTime),
                gte(derivedIntervals.endTime, new Date(rangeStartMs)),
              ),
            ),
          )
          .orderBy(asc(derivedIntervals.startTime))
      : [];

    const { signal, shape } = await resolveShape(detector, tz, rows);

    let runningNow = false;
    let totalEnergyKwh = 0;
    // Summed alongside the energy so the footer can show a genuine period-average power
    // (Σenergy ÷ Σduration). Open runs contribute no duration, matching their null avg power.
    let totalDurationSeconds = 0;
    const cost = knownSum();
    const emissions = knownSum();
    const renewable = knownSum();
    const events = rows.map((r) => {
      const ev = toEvent(r, shape);
      if (ev.running) runningNow = true;
      totalEnergyKwh += ev.energyKwh;
      totalDurationSeconds += ev.durationSeconds ?? 0;
      cost.add(ev.costC, ev.energyKwh);
      emissions.add(ev.emissionsG, ev.energyKwh);
      renewable.add(ev.renewableKwh, ev.energyKwh);
      return ev;
    });

    return NextResponse.json({
      role,
      events,
      signal,
      columns: shape.columns,
      totalEnergyKwh: roundToThree(totalEnergyKwh),
      totalDurationSeconds,
      totalCostC: cost.total(),
      costKnownKwh: cost.knownKwh(),
      totalEmissionsG: emissions.total(),
      emissionsKnownKwh: emissions.knownKwh(),
      totalRenewableKwh: renewable.total(),
      renewableKnownKwh: renewable.knownKwh(),
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
