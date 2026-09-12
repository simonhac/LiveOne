/**
 * Health monitor for the observations pipeline.
 *
 * GET /api/cron/monitor-observations
 *
 * The pipeline is async/best-effort: PG is fed via the QStash queue (publisher → receiver). When the
 * receiver is down/erroring, readings stop landing in PG and the pipeline silently falls behind (the
 * ~9 "down" windows in 2026). This cron catches that within minutes instead of weeks. It is READ-ONLY
 * and best-effort; it never throws and never mutates data.
 *
 * Signals (all self-contained):
 *   1. Response-presence — fraction of recent successful CRON sessions in PG carrying a `response`.
 *      Live polls always capture one, so a low fraction means the mirror pipeline is degraded.
 *   2. Raw-landing — most recent `point_readings.created_at`, and whether raw landed in the last hour
 *      despite successful CRON sessions existing (sessions but ~no raw ⇒ the queue is dropping readings).
 *   2b. PER-DEVICE poll staleness — each active polled device against its OWN slot. Signal 2 is a
 *      fleet-wide max(), so a single healthy device masks every other one going dark; this is the
 *      check that notices one vendor failing silently.
 *   3. Ingest-path health — per-lane backlog / in-flight / paused, the `stuck` head-of-line
 *      predicate, and DLQ depth. `stuck` is the check that would have caught 2026-09-09.
 *   4. Outbox relay — unpublished backlog + oldest-unpublished age.
 *   5. Battery-provenance — live-blend freshness (minutely), rollup freshness (daily heal), and the
 *      recent estimated fraction (attribution leaning on estimated/missing inputs). Skipped where no
 *      helper devices exist. A faithful "runaway segment" alert needs the fold's segment age persisted
 *      (see docs/architecture/battery-provenance.md, follow-ups) — deferred.
 *   5c. Battery SoC ↔ METER reconciliation — per area and complete day, ΔSoC·C must match the metered
 *      registers through the three-term loss model (η_c·chg − dis − idle). A residual above tolerance =
 *      a REAL meter/SoC feed failure (or a flagged, benign BMS recal snap) — the thing the loss model
 *      silences by construction on a healthy feed. See lib/battery-provenance/soc-meter-check.ts.
 *
 * Alerting: if any ALERT-severity issue fires, POST a Slack-compatible payload to
 * OBSERVATIONS_ALERT_WEBHOOK_URL (graceful no-op if unset) and always emit a structured console.error.
 * Returns a JSON status (configured:false when PG isn't wired) for manual checks + dashboards.
 *
 * Tuning via env (all optional): MONITOR_RESPONSE_PRESENCE_MIN, MONITOR_MIN_SESSIONS,
 * MONITOR_RAW_STALE_MINUTES, MONITOR_DEVICE_STALE_SLOTS, MONITOR_QUEUE_LAG_MAX, MONITOR_DLQ_ALERT, MONITOR_OUTBOX_BACKLOG_MAX,
 * MONITOR_OUTBOX_STALE_MINUTES, MONITOR_BATPROV_BLEND_STALE_MINUTES, MONITOR_BATPROV_ROLLUP_STALE_HOURS,
 * MONITOR_BATPROV_ESTIMATED_FRAC_MAX, MONITOR_BATPROV_SOC_METER_TOL_KWH.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { sendAlert as postAlert } from "@/lib/alerts";
import { planetscaleDb } from "@/lib/db/planetscale";
import { ReadingsDao } from "@/lib/readings";
import { DeviceRegistry } from "@/lib/registry";
import { checkSocMeterDivergence } from "@/lib/battery-provenance/soc-meter-check";
import { qstash } from "@/lib/qstash";
import { readIngestState } from "@/lib/observations/flow-control";
import {
  evaluateDeviceHealth,
  unhealthy,
} from "@/lib/monitoring/device-staleness";

export const maxDuration = 30;

type Severity = "ok" | "warn" | "alert";

interface Issue {
  severity: Exclude<Severity, "ok">;
  code: string;
  message: string;
}

const num = (env: string | undefined, fallback: number): number => {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
};

// Thresholds (env-overridable).
const RESPONSE_PRESENCE_MIN = num(
  process.env.MONITOR_RESPONSE_PRESENCE_MIN,
  0.8,
);
const MIN_SESSIONS = num(process.env.MONITOR_MIN_SESSIONS, 5); // don't judge on tiny samples
const RAW_STALE_MINUTES = num(process.env.MONITOR_RAW_STALE_MINUTES, 15);
// A device is stale when it has missed this many of its OWN slots in a row. 3 tolerates a vendor
// blip plus the ~3% of Vercel cron ticks that never fire, without tolerating a real outage: the
// 30-minute Amber vendor outage (6 slots) and the 25-minute Sigenergy 502 run would both have
// tripped it, while the ordinary 1-2 slot misses in the same 24 h would not.
//
// It is the DEFAULT, not the rule: an adapter may declare `staleBudgetMinutes` where its own
// reality doesn't fit a multiple of its slot (Amber's is a scheduled, nightly, 30-minute vendor
// maintenance window — see `lib/vendors/amber/adapter.ts`).
const DEVICE_STALE_SLOTS = num(process.env.MONITOR_DEVICE_STALE_SLOTS, 3);
const QUEUE_LAG_MAX = num(process.env.MONITOR_QUEUE_LAG_MAX, 1000);
const DLQ_ALERT = num(process.env.MONITOR_DLQ_ALERT, 50); // DLQ ≥ this ⇒ alert (any DLQ ⇒ warn)
// Outbox relay (Phase 4): a healthy relay keeps the unpublished backlog ≈ 0 and
// the oldest unpublished row fresh. A growing backlog / aging row ⇒ the relay is
// stalled.
const OUTBOX_BACKLOG_MAX = num(process.env.MONITOR_OUTBOX_BACKLOG_MAX, 500);
const OUTBOX_STALE_MINUTES = num(process.env.MONITOR_OUTBOX_STALE_MINUTES, 10);
// Battery-provenance (see docs/architecture/battery-provenance.md): the live blend advances every
// minute on the Area's helper device; the daily heal advances the flow_attr_1d rollup ~daily. A stale
// blend ⇒ the minutely provenance reconcile is failing; a stale rollup ⇒ the daily heal is failing; a
// high estimated fraction ⇒ too much attribution is leaning on estimated/missing inputs.
const BATPROV_BLEND_STALE_MINUTES = num(
  process.env.MONITOR_BATPROV_BLEND_STALE_MINUTES,
  15,
);
const BATPROV_ROLLUP_STALE_HOURS = num(
  process.env.MONITOR_BATPROV_ROLLUP_STALE_HOURS,
  30,
);
const BATPROV_ESTIMATED_FRAC_MAX = num(
  process.env.MONITOR_BATPROV_ESTIMATED_FRAC_MAX,
  0.6,
);
// SoC↔meter reconciliation: per complete day, |ΔSoC·C − (η_c·chg − dis − idle)| above this (kWh) means
// a meter or SoC feed is lying (healthy Daylesford days reconcile to ~±1 kWh; a recal snap ~+5).
const BATPROV_SOC_METER_TOL_KWH = num(
  process.env.MONITOR_BATPROV_SOC_METER_TOL_KWH,
  3,
);

/**
 * Send a Slack-compatible alert if a webhook is configured. Best-effort; never throws.
 * The webhook is shared across environments, so every message is prefixed with the
 * environment name — see `lib/alerts.ts`, which owns that policy for every sender.
 */
const sendAlert = (text: string) => postAlert(text, "[MonitorObservations]");

export async function GET(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const skip = cronSkipReason(request, auth);
  if (skip) return NextResponse.json(skip);

  if (!planetscaleDb) {
    return NextResponse.json({ configured: false });
  }
  const db = planetscaleDb;

  const issues: Issue[] = [];

  // ── 0: can we see Postgres at all? ──
  //
  // Every check below queries the same database it is judging, and each one catches its own errors
  // so that a single failure can't suppress the rest. The emergent behaviour was that a TOTAL
  // outage produced a full set of caught errors, `status` collapsed to "warn", and the webhook —
  // which only fires on "alert" — was never called. On 2026-09-11 that is why nothing spoke for
  // 8 h 49 m.
  //
  // So: probe connectivity FIRST and treat "cannot reach PG" as a single, unambiguous alert, then
  // short-circuit. One loud message beats five caught errors that add up to silence, and it avoids
  // promoting every individual catch (an unmigrated table must not page anyone).
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    console.error("[MonitorObservations] PG unreachable:", err);
    const message = `Postgres is unreachable from the monitor — no health check could run: ${String(err)}`;
    const sent = await sendAlert(`🚨 LiveOne observations mirror: ${message}`);
    return NextResponse.json({
      configured: true,
      status: "alert" as Severity,
      now: new Date().toISOString(),
      issues: [{ severity: "alert", code: "pg_unreachable", message }],
      checks: {},
      alertWebhookConfigured: Boolean(
        process.env.OBSERVATIONS_ALERT_WEBHOOK_URL,
      ),
      sentAlert: sent,
    });
  }

  const checks: Record<string, unknown> = {};

  // ── 1 + 2: response-presence and raw-landing, from PG ──
  try {
    // One shared 1h cutoff (sessions in SQL; raw point_readings via the readings DAO).
    const sinceMs = Date.now() - 60 * 60 * 1000;
    const since = new Date(sinceMs);
    const [res, raw1h, lastRawMs] = await Promise.all([
      db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM sessions
             WHERE created_at >= ${since}
               AND cause = 'CRON' AND successful = true)                       AS cron_sessions_1h,
          (SELECT count(*)::int FROM sessions
             WHERE created_at >= ${since}
               AND cause = 'CRON' AND successful = true
               AND response IS NOT NULL)                                       AS cron_sessions_1h_with_response
      `),
      ReadingsDao.countByCreatedAtSince("raw", sinceMs),
      ReadingsDao.latestRawCreatedAtMs(),
    ]);
    const r = ((res.rows ?? [])[0] ?? {}) as {
      cron_sessions_1h: number;
      cron_sessions_1h_with_response: number;
    };

    const sessions1h = Number(r.cron_sessions_1h ?? 0);
    const withResp = Number(r.cron_sessions_1h_with_response ?? 0);
    const lastRawAt = lastRawMs != null ? new Date(lastRawMs) : null;
    const presence = sessions1h > 0 ? withResp / sessions1h : null;
    const rawAgeMin = lastRawAt
      ? Math.round((Date.now() - lastRawAt.getTime()) / 60_000)
      : null;

    checks.responsePresence = {
      cronSessions1h: sessions1h,
      withResponse1h: withResp,
      ratio: presence,
      threshold: RESPONSE_PRESENCE_MIN,
    };
    checks.rawLanding = {
      raw1h,
      lastRawAt: lastRawAt ? lastRawAt.toISOString() : null,
      ageMinutes: rawAgeMin,
      staleThresholdMinutes: RAW_STALE_MINUTES,
    };

    if (
      sessions1h >= MIN_SESSIONS &&
      presence !== null &&
      presence < RESPONSE_PRESENCE_MIN
    ) {
      issues.push({
        severity: "alert",
        code: "response_presence_low",
        message: `Only ${(presence * 100).toFixed(0)}% of ${sessions1h} successful CRON sessions in the last hour carry a response (< ${(RESPONSE_PRESENCE_MIN * 100).toFixed(0)}%) — the mirror pipeline may be down.`,
      });
    }
    if (sessions1h >= MIN_SESSIONS && raw1h === 0) {
      issues.push({
        severity: "alert",
        code: "no_raw_despite_sessions",
        message: `${sessions1h} successful CRON sessions in the last hour but 0 raw readings landed in PG — the queue is dropping readings.`,
      });
    }
    if (rawAgeMin !== null && rawAgeMin > RAW_STALE_MINUTES) {
      issues.push({
        severity: "alert",
        code: "raw_landing_stale",
        message: `No raw readings have landed in PG for ${rawAgeMin} min (> ${RAW_STALE_MINUTES}).`,
      });
    }
  } catch (err) {
    console.error("[MonitorObservations] PG checks failed:", err);
    issues.push({
      // ALERT: see device_staleness_check_failed below. "Cannot determine health" must page.
      severity: "alert",
      code: "pg_check_failed",
      message: `Could not query PG health: ${String(err)}`,
    });
  }

  // ── 3b: PER-DEVICE poll staleness + failure run ──
  //
  // `raw_landing_stale` above is a fleet-wide `max(created_at)`, so ONE healthy device masks every
  // other device going dark — a vendor could fail silently for weeks and never trip an alert. This
  // check is per device, against its own declared slot, so "Enphase is hourly" and "Selectronic is
  // minutely" are held to their own standards rather than a single global threshold.
  //
  // The evaluation itself lives in lib/monitoring/device-staleness.ts because /api/health/devices
  // serves the same verdict to an external monitor, and the two must not drift.
  //
  // Separate try: a failure here must not suppress the checks above.
  try {
    const devices = unhealthy(await evaluateDeviceHealth(db));
    checks.devices = {
      unhealthy: devices.length,
      codes: devices.map((d) => `${d.vendor}/${d.rid}:${d.code}`),
    };
    for (const d of devices) {
      issues.push({
        // `device_failing` is the leading indicator — a device inside its budget but failing every
        // poll. It alerts rather than warns because a warn goes to console.warn and nowhere else,
        // and "we saw it coming and said nothing" is the exact failure this exists to prevent.
        severity: d.code === "device_never_polled" ? "warn" : "alert",
        code: d.code,
        message: d.message,
      });
    }
  } catch (err) {
    console.error(
      "[MonitorObservations] per-device staleness check failed:",
      err,
    );
    issues.push({
      // ALERT, not warn. Being unable to evaluate device health is not a lesser state than finding
      // a stale device — it is the state in which we cannot tell, which on 2026-09-11 is precisely
      // what happened for 8 h 49 m while this route reported "warn" and stayed silent.
      severity: "alert",
      code: "device_staleness_check_failed",
      message: `Could not evaluate per-device poll staleness: ${String(err)}`,
    });
  }

  // ── 4: outbox relay backlog/age (Phase 4) ──
  // Separate try so a not-yet-migrated outbox table never breaks the checks above.
  try {
    const res = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM observations_outbox
           WHERE published_at IS NULL)                AS outbox_backlog,
        (SELECT min(created_at) FROM observations_outbox
           WHERE published_at IS NULL)                AS outbox_oldest_at
    `);
    const r = ((res.rows ?? [])[0] ?? {}) as {
      outbox_backlog: number;
      outbox_oldest_at: Date | null;
    };
    const backlog = Number(r.outbox_backlog ?? 0);
    const oldestAt = r.outbox_oldest_at ? new Date(r.outbox_oldest_at) : null;
    const oldestAgeMin = oldestAt
      ? Math.round((Date.now() - oldestAt.getTime()) / 60_000)
      : null;

    checks.outbox = {
      backlog,
      oldestUnpublishedAt: oldestAt ? oldestAt.toISOString() : null,
      oldestAgeMinutes: oldestAgeMin,
      backlogMax: OUTBOX_BACKLOG_MAX,
      staleThresholdMinutes: OUTBOX_STALE_MINUTES,
    };

    if (backlog > OUTBOX_BACKLOG_MAX) {
      issues.push({
        severity: "alert",
        code: "outbox_backlog_high",
        message: `Outbox relay backlog is ${backlog} unpublished rows (> ${OUTBOX_BACKLOG_MAX}) — the relay is stalled.`,
      });
    }
    if (oldestAgeMin !== null && oldestAgeMin > OUTBOX_STALE_MINUTES) {
      issues.push({
        severity: "alert",
        code: "outbox_stale",
        message: `Oldest unpublished outbox row is ${oldestAgeMin} min old (> ${OUTBOX_STALE_MINUTES}) — the relay isn't draining.`,
      });
    }
  } catch (err) {
    console.error("[MonitorObservations] outbox check failed:", err);
    issues.push({
      severity: "warn",
      code: "outbox_check_failed",
      message: `Could not query outbox health: ${String(err)}`,
    });
  }

  // ── 5: battery-provenance freshness + confidence ──
  // Separate try so the not-everywhere flow_attr_1d table / absent helpers never break the checks above.
  try {
    // Helper-vendor device rids drive both helper_count and the blend-freshness max(interval_end). The
    // old query JOINed agg_5m to devices inside a CTE; resolving the helper ids first + a DAO
    // max-over-set is byte-identical (the CTE's data_quality column was selected but never used).
    // config-v4 slice K2: reads `devices` (was a hand-written `SELECT id FROM systems`, invisible to
    // tsc and therefore to the terminal window's drop).
    const helperIds = (
      (
        await db.execute(
          sql`SELECT rid AS id FROM devices WHERE vendor = 'helper'`,
        )
      ).rows ?? []
    ).map((h) => Number((h as { id: unknown }).id));

    const helperMappings = await DeviceRegistry.addrsForHandles(helperIds);
    const helperDeviceIds = helperIds.map((id) => {
      const mapping = helperMappings.get(id);
      if (!mapping)
        throw new Error(`Missing device mapping for helper system ${id}`);
      return mapping.deviceId;
    });
    const [res, blendLatestMs] = await Promise.all([
      db.execute(sql`
        SELECT
          (SELECT max(updated_at) FROM point_readings_flow_attr_1d)               AS rollup_updated,
          (SELECT max(day) FROM point_readings_flow_attr_1d)                      AS rollup_max_day,
          (SELECT sum(estimated_kwh) FROM point_readings_flow_attr_1d
             WHERE day >= to_char((now() AT TIME ZONE 'UTC') - interval '3 days','YYYY-MM-DD')) AS est_kwh_3d,
          (SELECT sum(energy_kwh) FROM point_readings_flow_attr_1d
             WHERE day >= to_char((now() AT TIME ZONE 'UTC') - interval '3 days','YYYY-MM-DD')) AS energy_kwh_3d
      `),
      ReadingsDao.maxAgg5mIntervalMsForDevices(helperDeviceIds),
    ]);
    const r = ((res.rows ?? [])[0] ?? {}) as {
      rollup_updated: Date | null;
      rollup_max_day: string | null;
      est_kwh_3d: number | null;
      energy_kwh_3d: number | null;
    };
    const helperCount = helperIds.length;

    if (helperCount === 0) {
      checks.batteryProvenance = { configured: false };
    } else {
      const blendLatest =
        blendLatestMs != null ? new Date(blendLatestMs) : null;
      const blendAgeMin = blendLatest
        ? Math.round((Date.now() - blendLatest.getTime()) / 60_000)
        : null;
      const rollupUpdated = r.rollup_updated
        ? new Date(r.rollup_updated)
        : null;
      const rollupAgeHrs = rollupUpdated
        ? (Date.now() - rollupUpdated.getTime()) / 3_600_000
        : null;
      const energy3d = Number(r.energy_kwh_3d ?? 0);
      const est3d = Number(r.est_kwh_3d ?? 0);
      const estFrac = energy3d > 0 ? est3d / energy3d : null;

      checks.batteryProvenance = {
        helperCount,
        blendLatest: blendLatest ? blendLatest.toISOString() : null,
        blendAgeMinutes: blendAgeMin,
        blendStaleThresholdMinutes: BATPROV_BLEND_STALE_MINUTES,
        rollupUpdatedAt: rollupUpdated ? rollupUpdated.toISOString() : null,
        rollupAgeHours: rollupAgeHrs === null ? null : Math.round(rollupAgeHrs),
        rollupMaxDay: r.rollup_max_day ?? null,
        rollupStaleThresholdHours: BATPROV_ROLLUP_STALE_HOURS,
        estimatedFraction3d: estFrac,
        estimatedFractionMax: BATPROV_ESTIMATED_FRAC_MAX,
      };

      // Blend not advancing ⇒ the minutely provenance reconcile is failing (a real regression).
      if (blendAgeMin === null) {
        issues.push({
          severity: "warn",
          code: "batprov_blend_missing",
          message: `${helperCount} battery-provenance helper device(s) exist but no blend agg_5m has ever been written.`,
        });
      } else if (blendAgeMin > BATPROV_BLEND_STALE_MINUTES) {
        issues.push({
          severity: "alert",
          code: "batprov_blend_stale",
          message: `Battery-provenance blend hasn't advanced for ${blendAgeMin} min (> ${BATPROV_BLEND_STALE_MINUTES}) — the minutely provenance reconcile may be failing.`,
        });
      }
      // Rollup not advancing ⇒ the daily heal is failing (less urgent — it's a daily job).
      if (rollupAgeHrs !== null && rollupAgeHrs > BATPROV_ROLLUP_STALE_HOURS) {
        issues.push({
          severity: "warn",
          code: "batprov_rollup_stale",
          message: `flow_attr_1d rollup last updated ${Math.round(rollupAgeHrs)}h ago (> ${BATPROV_ROLLUP_STALE_HOURS}) — the daily provenance heal may be failing.`,
        });
      }
      // Too much attribution leaning on estimated/missing inputs (data-quality signal, not an outage).
      if (
        estFrac !== null &&
        energy3d > 0 &&
        estFrac > BATPROV_ESTIMATED_FRAC_MAX
      ) {
        issues.push({
          severity: "warn",
          code: "batprov_estimated_fraction_high",
          message: `${(estFrac * 100).toFixed(0)}% of the last 3 days of attributed energy used an estimated/missing input (> ${(BATPROV_ESTIMATED_FRAC_MAX * 100).toFixed(0)}%) — cost/carbon will firm up when the upstream data lands.`,
        });
      }
    }
  } catch (err) {
    console.error(
      "[MonitorObservations] battery-provenance check failed:",
      err,
    );
    issues.push({
      severity: "warn",
      code: "batprov_check_failed",
      message: `Could not query battery-provenance health: ${String(err)}`,
    });
  }

  // ── 5c: battery SoC ↔ meter reconciliation (three-term loss model) ──
  // On a healthy feed the loss model closes each complete day to ~±1 kWh by construction, so a residual
  // above tolerance is a REAL meter/SoC fault (stale register, re-scaled feed, lying SoC) — or a benign
  // BMS recal snap, which arrives flagged. Skips SoC-blind and not-yet-learned ("unarmed") areas.
  try {
    const socMeter = await checkSocMeterDivergence(
      Date.now(),
      BATPROV_SOC_METER_TOL_KWH,
    );
    const diverged = socMeter.filter((r) => r.status === "divergent");
    checks.batteryProvenanceSocMeter = {
      areasChecked: socMeter.length,
      tolKwh: BATPROV_SOC_METER_TOL_KWH,
      byArea: socMeter.map((r) => ({
        handle: r.handle,
        status: r.status,
        daysJudged: r.daysJudged,
        divergentDays: r.divergentDays,
      })),
    };
    if (diverged.length > 0) {
      const detail = diverged
        .map((r) => {
          const days = r.divergentDays
            .map(
              (d) =>
                `${d.day}: SoC ${d.socKwh} vs model ${d.modelKwh} kWh${d.recal ? " (recal)" : ""}`,
            )
            .join("; ");
          return `handle ${r.handle}: ${days}`;
        })
        .join(" | ");
      issues.push({
        severity: "warn",
        code: "batprov_soc_meter_divergence",
        message: `Battery SoC disagrees with the metered registers beyond ±${BATPROV_SOC_METER_TOL_KWH} kWh/day — ${detail}. Unflagged days mean a meter/SoC feed fault; "(recal)" days are benign BMS re-syncs.`,
      });
    }
  } catch (err) {
    console.error(
      "[MonitorObservations] SoC↔meter reconciliation check failed:",
      err,
    );
    issues.push({
      severity: "warn",
      code: "batprov_soc_meter_check_failed",
      message: `Could not run the SoC↔meter reconciliation check: ${String(err)}`,
    });
  }

  // ── 3: ingest backlog + lane health + DLQ depth ──
  //
  // 🛑 `lag`/backlog ALONE is not the signal. During the 2026-09-09 outage it climbed monotonically
  // (199 → 1053) and was read twice as "the receiver isn't keeping up"; a busy path and a blocked one
  // both grow. `ingest_lane_stuck` is the unambiguous form — saturated, backed up, and nothing
  // landing — and it would have been true from minute one, while `dlqCount` sat at 0 for 2h20m.
  if (!qstash) {
    checks.queue = { configured: false };
  } else {
    try {
      const ingest = await readIngestState();
      const dlq = await qstash.dlq.listMessages({ count: 100 });
      const dlqCount = (dlq.messages ?? []).length;

      checks.queue = {
        waiting: ingest.waiting,
        inFlight: ingest.inFlight,
        paused: ingest.paused,
        pausedLanes: ingest.pausedLanes,
        stalledMinutes: ingest.stalledMinutes,
        lanes: ingest.lanes.map((l) => ({
          lane: l.lane,
          waiting: l.waiting,
          inFlight: l.inFlight,
          parallelism: l.parallelism,
          pinned: l.pinned,
          paused: l.paused,
          idle: l.idle,
          stuck: l.stuck,
          error: l.error,
        })),
        globalParallelism: ingest.globalParallelism,
        dlqCount,
        lagMax: QUEUE_LAG_MAX,
        // compat: the historical field name, for anything reading this JSON body.
        lag: ingest.waiting,
      };

      for (const lane of ingest.lanes) {
        if (lane.error)
          issues.push({
            severity: "warn",
            code: "ingest_lane_unreadable",
            message:
              `Could not read ingest lane "${lane.lane}" (${lane.key}) from QStash: ${lane.error}. ` +
              `Its numbers below are zeros, NOT a measurement.`,
          });
        if (!lane.stuck) continue;
        issues.push({
          severity: "alert",
          code: "ingest_lane_stuck",
          message:
            `Ingest lane "${lane.lane}" is STUCK — ${lane.inFlight}/${lane.parallelism} deliveries ` +
            `in flight, ${lane.waiting} waiting, and nothing has landed in PG for ` +
            `${ingest.stalledMinutes} min. Head-of-line blocking.`,
        });
      }

      if (ingest.waiting > QUEUE_LAG_MAX) {
        issues.push({
          severity: "alert",
          code: "ingest_backlog_high",
          message: `Ingest backlog is ${ingest.waiting} (> ${QUEUE_LAG_MAX}) — the receiver isn't keeping up.`,
        });
      }
      if (dlqCount >= DLQ_ALERT) {
        issues.push({
          severity: "alert",
          code: "dlq_high",
          message: `${dlqCount}+ messages in the DLQ (≥ ${DLQ_ALERT}) — failed deliveries are piling up.`,
        });
      } else if (dlqCount > 0) {
        issues.push({
          severity: "warn",
          code: "dlq_present",
          message: `${dlqCount} message(s) in the DLQ — investigate failed deliveries.`,
        });
      }
      if (ingest.pausedLanes.length > 0) {
        issues.push({
          severity: "warn",
          code: "ingest_paused",
          message: `Observations ingest is PAUSED (${ingest.pausedLanes.join(", ")}) — ingestion into PG is halted.`,
        });
      }
    } catch (err) {
      console.error("[MonitorObservations] ingest checks failed:", err);
      issues.push({
        severity: "warn",
        code: "ingest_check_failed",
        message: `Could not query the observations ingest path / DLQ: ${String(err)}`,
      });
    }
  }

  const status: Severity = issues.some((i) => i.severity === "alert")
    ? "alert"
    : issues.length > 0
      ? "warn"
      : "ok";

  let sentAlert = false;
  if (status === "alert") {
    const lines = issues
      .filter((i) => i.severity === "alert")
      .map((i) => `• ${i.message}`)
      .join("\n");
    console.error(
      `[MonitorObservations] ALERT — observations mirror unhealthy:\n${lines}`,
    );
    sentAlert = await sendAlert(
      `🚨 LiveOne observations mirror unhealthy:\n${lines}`,
    );
  } else if (status === "warn") {
    console.warn(
      `[MonitorObservations] WARN: ${issues.map((i) => i.code).join(", ")}`,
    );
  }

  return NextResponse.json({
    configured: true,
    status,
    now: new Date().toISOString(),
    issues,
    checks,
    alertWebhookConfigured: Boolean(process.env.OBSERVATIONS_ALERT_WEBHOOK_URL),
    sentAlert,
  });
}
