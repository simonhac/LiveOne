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
 *
 * Alerting: if any ALERT-severity issue fires, POST a Slack-compatible payload to
 * OBSERVATIONS_ALERT_WEBHOOK_URL (graceful no-op if unset) and always emit a structured console.error.
 * Returns a JSON status (configured:false when PG isn't wired) for manual checks + dashboards.
 *
 * Tuning via env (all optional): MONITOR_RESPONSE_PRESENCE_MIN, MONITOR_MIN_SESSIONS,
 * MONITOR_RAW_STALE_MINUTES, MONITOR_QUEUE_LAG_MAX, MONITOR_DLQ_ALERT.
 */

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { planetscaleDb } from "@/lib/db/planetscale";
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
// stalled. Inert until WRITE_OUTBOX is on (backlog stays 0 otherwise).
const OUTBOX_BACKLOG_MAX = num(process.env.MONITOR_OUTBOX_BACKLOG_MAX, 500);
const OUTBOX_STALE_MINUTES = num(process.env.MONITOR_OUTBOX_STALE_MINUTES, 10);

/** Send a Slack-compatible alert if a webhook is configured. Best-effort; never throws. */
async function sendAlert(text: string): Promise<boolean> {
  const url = process.env.OBSERVATIONS_ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
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
