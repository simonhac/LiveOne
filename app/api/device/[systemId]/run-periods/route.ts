import { NextRequest, NextResponse } from "next/server";
import { requireDashboardAccess } from "@/lib/api-auth";
import { subjectDisplayTimezone } from "@/lib/dashboard/subject";
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
import { memberSystemIds } from "@/lib/capabilities/server";
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
  /** The current signal's RAW unit, to decide whether a row's stored unit is still the live one. */
  signalMetricUnit: string | null;
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
  // The `detector_version === detector.detectorVersion` gate that used to stand here is GONE
  // (migration 0055). It existed for one reason: `avg_power_w` was a number with no recorded unit,
  // so the only evidence that it meant what the header said was "the same detector version wrote
  // it", and anything older had to be suppressed. `signal_unit` is now stored per row, so the value
  // is self-describing and every row can be served — labelled, rather than blank.
  //
  // Note this is strictly MORE data than the gate allowed: it un-suppresses all 74 of Daylesford's
  // version-1 runs. What keeps that honest is `columns.signalUnitPerRow` + the per-event unit below,
  // not a version comparison.
  const avgSignal = r.avgSignal;
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
    /** Mean of the raw on-samples, in `signalUnit`. Null only when the row stored no statistic. */
    avgSignal,
    /**
     * The unit THIS row's statistics are in, display-spelled. Carried per event, not per response,
     * because one window can contain both (Daylesford's 74 W runs and 3 rpm runs). Null for a row
     * predating migration 0055's backfill — impossible on prod/dev, where the backfill is total.
     */
    signalUnit: r.signalUnit ? getUnitDisplay(r.signalUnit) : null,
    /**
     * True average power (W). From energy ÷ duration wherever an energy point is bound; only when
     * the signal ITSELF is power (and no energy point exists) does it fall back to the signal mean,
     * where `Math.abs` is right because the figure is being presented as a magnitude.
     *
     * The fallback is now gated on THE ROW's unit, not just the detector's current config: in a
     * mixed window some rows are not power at all, and passing an rpm through as Watts is exactly
     * the mislabelling being retired. Such a row reports no average power rather than a wrong one.
     */
    avgPowerW:
      s.columns.avgPowerBasis === "signal"
        ? avgSignal == null || r.signalUnit !== s.signalMetricUnit
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
    // Same principle as the provenance gate below, applied to units: read what the ROWS carry, not
    // what the config says they should. A window straddling the re-point holds both.
    rowSignalUnits: rows.map((r) => r.signalUnit),
    hasEnergyPoint: detector?.energyPoint != null,
    provenance: {
      cost: rows.some((r) => r.costC != null),
      emissions: rows.some((r) => r.emissionsG != null),
      renewable: rows.some((r) => r.renewableKwh != null),
    },
  });
  return {
    signal,
    shape: { tz, columns, signalMetricUnit: signal?.metricUnit ?? null },
  };
}

/**
 * The enabled detector for `(handle, role)`, looking through an AREA'S MEMBERS when the handle
 * itself has none.
 *
 * A detector hangs off the area-of-one of the device that owns its signal point (`ensureRunDetector`
 * says so at length, and `capabilitiesForDevice` probes members for exactly this reason) — never off
 * the composite site area. But a composite is precisely what the caller usually holds: the stacked
 * chart is keyed on Kinkora Unified (handle 8) while the EV detector lives on Kinkora Mondo (6). So
 * ask the handle first, then its members.
 *
 * First member wins. A composite with two detectors for the same role is not a shape that exists
 * here (a role is one physical thing per site), and picking arbitrarily between them would be a
 * worse answer than picking the first — but neither is a *good* answer, so the ambiguity is left
 * visible rather than papered over with a merge.
 *
 * `memberSystemIds` returns `[handle]` for a real device, so the fallback is a no-op — not a second
 * lookup — in the single-device case.
 */
async function resolveDetector(
  handle: number,
  role: string,
): Promise<ResolvedRunDetector | null> {
  const own = await getRunDetectorForHandleRole(handle, role);
  if (own) return own;
  for (const member of await memberSystemIds(handle)) {
    if (member === handle) continue;
    const det = await getRunDetectorForHandleRole(member, role);
    if (det) return det;
  }
  return null;
}

/**
 * GET /api/device/{systemId}/run-periods?role=generator&period=30d
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

    // Phase 13 PR 2: was `authResult.system.displayTimezone` off the legacy device-shaped view. An Area
    // carries its own `display_timezone`, so the subject answers this natively for either kind.
    const tz = subjectDisplayTimezone(authResult.subject);
    const db = requirePlanetscaleDb();

    // The intervals hang off the run detector for this (handle, role). No detector configured →
    // no rows, which is the same empty response this endpoint has always given for an untracked
    // system. Resolved through the shared handle→area mapping so reader and writer always agree,
    // then through the area's members (see `resolveDetector`).
    const detector = await resolveDetector(systemId, role);

    // Paged mode (limit present): most-recent-first, page back through ALL history. Used by the
    // dashboard `runs` card. Bounded by limit (no time window).
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
