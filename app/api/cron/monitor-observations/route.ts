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
 *   3. Queue health — QStash queue lag + DLQ depth (+ paused state).
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
 * MONITOR_RAW_STALE_MINUTES, MONITOR_QUEUE_LAG_MAX, MONITOR_DLQ_ALERT, MONITOR_OUTBOX_BACKLOG_MAX,
 * MONITOR_OUTBOX_STALE_MINUTES, MONITOR_BATPROV_BLEND_STALE_MINUTES, MONITOR_BATPROV_ROLLUP_STALE_HOURS,
 * MONITOR_BATPROV_ESTIMATED_FRAC_MAX, MONITOR_BATPROV_SOC_METER_TOL_KWH.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { envLabel } from "@/lib/env";
import { planetscaleDb } from "@/lib/db/planetscale";
import { checkSocMeterDivergence } from "@/lib/battery-provenance/soc-meter-check";
import { qstash, OBSERVATIONS_QUEUE_NAME } from "@/lib/qstash";

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
 * environment name (see lib/env.ts).
 */
async function sendAlert(text: string): Promise<boolean> {
  const url = process.env.OBSERVATIONS_ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[${envLabel()}] ${text}` }),
    });
    return res.ok;
  } catch (err) {
    console.error("[MonitorObservations] alert webhook failed:", err);
    return false;
  }
}

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
  const checks: Record<string, unknown> = {};

  // ── 1 + 2: response-presence and raw-landing, from PG ──
  try {
    const res = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM sessions
           WHERE created_at >= now() - interval '1 hour'
             AND cause = 'CRON' AND successful = true)                       AS cron_sessions_1h,
        (SELECT count(*)::int FROM sessions
           WHERE created_at >= now() - interval '1 hour'
             AND cause = 'CRON' AND successful = true
             AND response IS NOT NULL)                                       AS cron_sessions_1h_with_response,
        (SELECT count(*)::int FROM point_readings
           WHERE created_at >= now() - interval '1 hour')                    AS raw_1h,
        (SELECT max(created_at) FROM point_readings)                         AS last_raw_at
    `);
    const r = ((res.rows ?? [])[0] ?? {}) as {
      cron_sessions_1h: number;
      cron_sessions_1h_with_response: number;
      raw_1h: number;
      last_raw_at: Date | null;
    };

    const sessions1h = Number(r.cron_sessions_1h ?? 0);
    const withResp = Number(r.cron_sessions_1h_with_response ?? 0);
    const raw1h = Number(r.raw_1h ?? 0);
    const lastRawAt = r.last_raw_at ? new Date(r.last_raw_at) : null;
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
        message: `${sessions1h} successful CRON sessions in the last hour but 0 raw point_readings landed in PG — the queue is dropping readings.`,
      });
    }
    if (rawAgeMin !== null && rawAgeMin > RAW_STALE_MINUTES) {
      issues.push({
        severity: "alert",
        code: "raw_landing_stale",
        message: `No raw point_readings have landed in PG for ${rawAgeMin} min (> ${RAW_STALE_MINUTES}).`,
      });
    }
  } catch (err) {
    console.error("[MonitorObservations] PG checks failed:", err);
    issues.push({
      severity: "warn",
      code: "pg_check_failed",
      message: `Could not query PG health: ${String(err)}`,
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
    const res = await db.execute(sql`
      WITH blend AS (
        SELECT a.interval_end, a.data_quality
        FROM point_readings_agg_5m a
        JOIN systems s ON s.id = a.system_id
        WHERE s.vendor_type = 'helper'
      )
      SELECT
        (SELECT count(*)::int FROM systems WHERE vendor_type='helper')          AS helper_count,
        (SELECT max(interval_end) FROM blend)                                   AS blend_latest,
        (SELECT max(updated_at) FROM point_readings_flow_attr_1d)               AS rollup_updated,
        (SELECT max(day) FROM point_readings_flow_attr_1d)                      AS rollup_max_day,
        (SELECT sum(estimated_kwh) FROM point_readings_flow_attr_1d
           WHERE day >= to_char((now() AT TIME ZONE 'UTC') - interval '3 days','YYYY-MM-DD')) AS est_kwh_3d,
        (SELECT sum(energy_kwh) FROM point_readings_flow_attr_1d
           WHERE day >= to_char((now() AT TIME ZONE 'UTC') - interval '3 days','YYYY-MM-DD')) AS energy_kwh_3d
    `);
    const r = ((res.rows ?? [])[0] ?? {}) as {
      helper_count: number;
      blend_latest: Date | null;
      rollup_updated: Date | null;
      rollup_max_day: string | null;
      est_kwh_3d: number | null;
      energy_kwh_3d: number | null;
    };
    const helperCount = Number(r.helper_count ?? 0);

    if (helperCount === 0) {
      checks.batteryProvenance = { configured: false };
    } else {
      const blendLatest = r.blend_latest ? new Date(r.blend_latest) : null;
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

  // ── 3: queue lag + DLQ depth ──
  if (!qstash) {
    checks.queue = { configured: false };
  } else {
    try {
      const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
      let lag = 0;
      let paused = false;
      try {
        const info = await queue.get();
        lag = info.lag ?? 0;
        paused = info.paused ?? false;
      } catch (e: any) {
        if (!(e?.message?.includes("not found") || e?.status === 404)) throw e;
      }
      const dlq = await qstash.dlq.listMessages({ count: 100 });
      const dlqCount = (dlq.messages ?? []).length;

      checks.queue = { lag, paused, dlqCount, lagMax: QUEUE_LAG_MAX };

      if (lag > QUEUE_LAG_MAX) {
        issues.push({
          severity: "alert",
          code: "queue_lag_high",
          message: `QStash queue lag is ${lag} (> ${QUEUE_LAG_MAX}) — the receiver isn't keeping up.`,
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
      if (paused) {
        issues.push({
          severity: "warn",
          code: "queue_paused",
          message: `The observations queue is PAUSED — ingestion into PG is halted.`,
        });
      }
    } catch (err) {
      console.error("[MonitorObservations] queue checks failed:", err);
      issues.push({
        severity: "warn",
        code: "queue_check_failed",
        message: `Could not query QStash queue/DLQ: ${String(err)}`,
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
