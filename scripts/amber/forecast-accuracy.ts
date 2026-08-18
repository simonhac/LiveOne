#!/usr/bin/env tsx
/**
 * Amber price-forecast accuracy — how wrong is Amber's published forecast, N hours out?
 *
 * Reads `amber_forecast_history` (the change-only capture of what Amber was publishing, added by
 * #373/#374) and scores it against the settled price for the same interval, per lead time. It also
 * prints a CAPTURE HEALTH preamble first, because every number below it is worthless if the logger
 * stopped: a silent capture outage and a genuinely unchanging forecast look identical in a
 * change-only table, and only the poll cadence tells them apart.
 *
 * Read-only. Safe against prod.
 *
 * Conventions that matter:
 *   - **Lead anchors to the interval END.** "6h out" = the last forecast published at or before
 *     `interval_end − 6h`. The interval ending 14:00 covers 13:30-14:00, so that is 5.5h before it
 *     starts. `cutoffMsFor` in lib/vendors/amber/forecast-accuracy.ts owns this.
 *   - **Truth** is the settled 5m-aggregate price for the same `interval_end`, preferring `b`
 *     (billable, final) over `a` (actual). Both tables key on Amber's `nemTime`, so the join is
 *     plain equality — no timezone arithmetic.
 *   - **Coverage** is `paired / targets`, where targets = intervals that were captured AND have
 *     settled truth. An interval with no forecast at that lead was outside Amber's horizon (or
 *     predates the capture); it lowers coverage rather than being scored as a hit or a miss.
 *   - `--start`/`--end` are AEST calendar days (fixed +10, no DST), inclusive.
 *
 * Usage:
 *   npm run amber:forecast-accuracy
 *   npm run amber:forecast-accuracy -- --days=7 --leads=1,2,6,12
 *   npm run amber:forecast-accuracy -- --start=2026-08-15 --end=2026-08-21 --csv=.context/afa.csv
 *   npm run amber:forecast-accuracy -- --health-only
 *   npm run amber:forecast-accuracy -- --no-chart --json
 *
 * Against PROD (the dev mirror lags ~2h and never back-fills prod history):
 *   pscale role create liveone sydney fc-read --inherited-roles pg_read_all_data --ttl 1h --format json
 *   PLANETSCALE_DATABASE_URL="<database_url>" npm run amber:forecast-accuracy -- --days=7
 *   pscale role delete liveone sydney <role-id> --force
 */

// Postgres `timestamp` columns here are naive UTC, and node-pg parses them into Dates using the
// process timezone. On a laptop set to Australia/Melbourne that shifts every reading by 10-11h and
// the forecast↔actual join silently returns nothing. Pin it before any Date exists.
process.env.TZ = "UTC";

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import type {
  AccuracySummary,
  ForecastObservation,
  SettledActual,
  SkillScore,
} from "@/lib/vendors/amber/forecast-accuracy";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const AEST_OFFSET_MS = 10 * HOUR_MS; // fixed +10, no DST — Amber's nemTime basis

/** Amber `channelType` → the `points.physical_path` its settled price lands on. */
const CHANNEL_POINTS: Record<string, { path: string; label: string }> = {
  general: { path: "E1/perKwh", label: "grid import" },
  feedIn: { path: "B1/perKwh", label: "grid export (feed-in)" },
  controlledLoad: { path: "CL1/perKwh", label: "controlled load" },
};

interface Args {
  deviceRid?: number;
  leads: number[];
  days: number;
  start?: string;
  end?: string;
  channels: string[];
  maxStalenessMin?: number;
  csv?: string;
  csvPairs?: string;
  chart: string | null;
  json: boolean;
  healthOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const has = (name: string) => argv.includes(`--${name}`);

  const leads = (get("leads") ?? "1,2,6,12")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (leads.length === 0) throw new Error("--leads must list positive hours");

  const channels = (get("channels") ?? "general,feedIn")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of channels) {
    if (!CHANNEL_POINTS[c]) {
      throw new Error(
        `unknown channel '${c}' (expected ${Object.keys(CHANNEL_POINTS).join(", ")})`,
      );
    }
  }

  const deviceRid = get("device") ? Number(get("device")) : undefined;
  const maxStaleness = get("max-staleness-min");

  return {
    deviceRid,
    leads,
    days: Number(get("days") ?? 7),
    start: get("start"),
    end: get("end"),
    channels,
    maxStalenessMin:
      maxStaleness === undefined ? undefined : Number(maxStaleness),
    csv: get("csv"),
    csvPairs: get("csv-pairs"),
    chart: has("no-chart")
      ? null
      : (get("chart") ?? ".context/amber-forecast-accuracy.png"),
    json: has("json"),
    healthOnly: has("health-only"),
  };
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────

/** AEST wall-clock for a UTC epoch — Amber's own basis, so intervals read as Amber labels them. */
function aest(ms: number, withSeconds = false): string {
  const iso = new Date(ms + AEST_OFFSET_MS).toISOString();
  return withSeconds
    ? iso.slice(0, 19).replace("T", " ")
    : iso.slice(0, 16).replace("T", " ");
}

function num(v: number, dp = 2, width = 6): string {
  return (Number.isFinite(v) ? v.toFixed(dp) : "—").padStart(width);
}

function pct(v: number, width = 5): string {
  return (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—").padStart(
    width,
  );
}

function toPgTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** AEST calendar day 'YYYY-MM-DD' → the UTC epoch of its 00:00 boundary. */
function aestDayStartMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00+10:00`);
  if (!Number.isFinite(ms))
    throw new Error(`bad date '${day}' (expected YYYY-MM-DD)`);
  return ms;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { sql } = await import("drizzle-orm");
  const { ReadingsDao } = await import("@/lib/readings");
  const { Point } = await import("@/lib/ids");
  const {
    pairForecastsWithActuals,
    persistenceSkill,
    scoreableTargets,
    selectTruth,
    summarisePairs,
    truthDisagreements,
  } = await import("@/lib/vendors/amber/forecast-accuracy");

  const db = requirePlanetscaleDb();
  const rowsOf = <T>(res: unknown): T[] =>
    ((res as { rows?: unknown[] }).rows ?? res) as T[];

  // ── device ────────────────────────────────────────────────────────────────
  const deviceRows = rowsOf<{ rid: number; name: string }>(
    await db.execute(
      sql`SELECT rid, name FROM devices WHERE vendor = 'amber' AND status = 'active' ORDER BY rid`,
    ),
  ).map((r) => ({ rid: Number(r.rid), name: String(r.name) }));

  let device = deviceRows.find((d) => d.rid === args.deviceRid);
  if (args.deviceRid !== undefined && !device) {
    throw new Error(
      `no active Amber device with rid=${args.deviceRid} (have: ${deviceRows.map((d) => d.rid).join(", ") || "none"})`,
    );
  }
  if (!device) {
    if (deviceRows.length !== 1) {
      throw new Error(
        deviceRows.length === 0
          ? "no active Amber device found"
          : `${deviceRows.length} Amber devices — pass --device=<rid>: ${deviceRows.map((d) => `${d.rid} (${d.name})`).join(", ")}`,
      );
    }
    device = deviceRows[0];
  }

  // ── window ────────────────────────────────────────────────────────────────
  const nowMs = Date.now();
  const toMs = args.end ? aestDayStartMs(args.end) + DAY_MS : nowMs;
  const fromMs = args.start
    ? aestDayStartMs(args.start)
    : toMs - args.days * DAY_MS;
  if (fromMs >= toMs) throw new Error("empty window (--start is after --end)");

  console.log(
    `\nAmber forecast accuracy — device ${device.rid} (${device.name})\n` +
      `window ${aest(fromMs)} → ${aest(toMs)} AEST  (all times AEST, prices c/kWh incl GST)`,
  );

  await reportHealth(db, sql, device.rid, fromMs, toMs, rowsOf);
  if (args.healthOnly) return;

  // ── truth: settled prices from the 5m aggregate, via the readings seam ─────
  // Reach back an extra day so the persistence baseline (same half-hour yesterday) exists for the
  // first intervals in the window.
  const pointRows = rowsOf<{ point_uid: string; physical_path: string }>(
    await db.execute(sql`
      SELECT p.id AS point_uid, p.physical_path
      FROM points p JOIN devices d ON d.id = p.device_id
      WHERE d.rid = ${device.rid}
        AND p.physical_path IN (${sql.join(
          args.channels.map((c) => sql`${CHANNEL_POINTS[c].path}`),
          sql`, `,
        )})`),
  );
  const pointByPath = new Map(
    pointRows.map((r) => [
      String(r.physical_path),
      Point.encode(String(r.point_uid)),
    ]),
  );
  const missing = args.channels.filter(
    (c) => !pointByPath.has(CHANNEL_POINTS[c].path),
  );
  if (missing.length) {
    throw new Error(
      `device ${device.rid} has no price point for channel(s) ${missing.join(", ")} ` +
        `(expected physical_path ${missing.map((c) => CHANNEL_POINTS[c].path).join(", ")})`,
    );
  }

  const series = await ReadingsDao.read5m([...pointByPath.values()], {
    fromMs: fromMs - DAY_MS,
    toMs,
  });

  // ── per-channel scoring ───────────────────────────────────────────────────
  const summaries: {
    channel: string;
    lead: number;
    summary: AccuracySummary;
    skill: SkillScore | null;
  }[] = [];
  const pairRows: string[] = [
    "channel,lead_hours,interval_end_aest,observed_at_aest,staleness_min,forecast,actual,error,adv_predicted,in_band",
  ];

  for (const channel of args.channels) {
    const point = pointByPath.get(CHANNEL_POINTS[channel].path)!;
    const readings: SettledActual[] = (series.get(point) ?? [])
      .filter((r) => r.avg !== null && r.dataQuality !== null)
      .map((r) => ({
        intervalEndMs: r.intervalEndMs,
        value: r.avg!,
        quality: r.dataQuality!,
      }));
    const truth = selectTruth(readings);
    const disagree = truthDisagreements(readings);

    const captured = rowsOf<{ interval_end_ms: string }>(
      await db.execute(sql`
        SELECT DISTINCT (extract(epoch FROM interval_end) * 1000)::bigint AS interval_end_ms
        FROM amber_forecast_history
        WHERE device_rid = ${device.rid} AND channel = ${channel}
          AND interval_end >= ${toPgTimestamp(fromMs)}::timestamp
          AND interval_end <= ${toPgTimestamp(toMs)}::timestamp`),
    ).map((r) => Number(r.interval_end_ms));
    const targets = scoreableTargets(captured, truth);

    const settledCount = { b: 0, a: 0 } as Record<string, number>;
    for (const t of truth.values())
      settledCount[t.quality] = (settledCount[t.quality] ?? 0) + 1;

    console.log(
      `\n${channel.toUpperCase()} — ${CHANNEL_POINTS[channel].label}\n` +
        `  truth: ${truth.size} settled intervals (${
          Object.entries(settledCount)
            .map(([q, n]) => `${n} ${q}`)
            .join(", ") || "none"
        }); ` +
        `a/b disagree on ${disagree.differing} of ${disagree.compared} restated\n` +
        `  ${targets} scoreable target intervals (captured + settled)`,
    );

    if (targets === 0) {
      console.log("  nothing to score in this window.");
      for (const lead of args.leads) {
        summaries.push({
          channel,
          lead,
          summary: summarisePairs([], 0),
          skill: null,
        });
      }
      continue;
    }

    console.log(
      "\n  lead  paired  cover     MAE    bias    RMSE     p50     p90     max  band%  advMAE  skill  staleP90",
    );

    for (const lead of args.leads) {
      const revisions = rowsOf<{
        interval_end_ms: string;
        observed_at_ms: string;
        per_kwh: number | null;
        adv_low: number | null;
        adv_predicted: number | null;
        adv_high: number | null;
      }>(
        await db.execute(sql`
          SELECT DISTINCT ON (interval_end)
                 (extract(epoch FROM interval_end) * 1000)::bigint AS interval_end_ms,
                 (extract(epoch FROM observed_at) * 1000)::bigint AS observed_at_ms,
                 per_kwh, adv_low, adv_predicted, adv_high
          FROM amber_forecast_history
          WHERE device_rid = ${device.rid} AND channel = ${channel}
            AND interval_end >= ${toPgTimestamp(fromMs)}::timestamp
            AND interval_end <= ${toPgTimestamp(toMs)}::timestamp
            AND observed_at <= interval_end - ${lead} * interval '1 hour'
          ORDER BY interval_end, observed_at DESC`),
      ).map(
        (r): ForecastObservation => ({
          intervalEndMs: Number(r.interval_end_ms),
          observedAtMs: Number(r.observed_at_ms),
          perKwh: r.per_kwh,
          advLow: r.adv_low,
          advPredicted: r.adv_predicted,
          advHigh: r.adv_high,
        }),
      );

      const pairs = pairForecastsWithActuals(revisions, truth, lead, {
        maxStalenessMin: args.maxStalenessMin,
      });
      const summary = summarisePairs(pairs, targets);
      const skill = persistenceSkill(pairs, truth);
      summaries.push({ channel, lead, summary, skill });

      console.log(
        `  ${String(lead).padStart(3)}h  ${String(summary.paired).padStart(6)}  ` +
          `${pct(summary.coverage)}  ${num(summary.mae, 2, 6)}  ${num(summary.bias, 2, 6)}  ` +
          `${num(summary.rmse, 2, 6)}  ${num(summary.p50AbsError, 2, 6)}  ` +
          `${num(summary.p90AbsError, 2, 6)}  ${num(summary.maxAbsError, 2, 6)}  ` +
          `${pct(summary.bandCoverage)}  ${num(summary.advPredictedMae, 2, 6)}  ` +
          `${num(skill?.skill ?? NaN, 2, 5)}  ${num(summary.p90StalenessMin, 1, 8)}`,
      );

      for (const p of pairs) {
        pairRows.push(
          [
            channel,
            lead,
            aest(p.intervalEndMs),
            aest(p.observedAtMs, true),
            p.stalenessMin.toFixed(1),
            p.forecast,
            p.actual,
            p.error.toFixed(4),
            p.advPredicted ?? "",
            p.inBand === null ? "" : p.inBand,
          ].join(","),
        );
      }
    }

    const withSkill = summaries.filter((s) => s.channel === channel && s.skill);
    if (withSkill.length) {
      console.log(
        `  skill is vs persistence (same half-hour yesterday), MAE ` +
          `${withSkill[0].skill!.maePersistence.toFixed(2)} c/kWh over ${withSkill[0].skill!.n} intervals; ` +
          `>0 means Amber beats it.`,
      );
    }
  }

  // ── artefacts ─────────────────────────────────────────────────────────────
  if (args.csv) {
    const header =
      "channel,lead_hours,targets,paired,coverage,mae,bias,rmse,p50_abs_error,p90_abs_error," +
      "max_abs_error,band_coverage,adv_predicted_mae,skill,persistence_mae,p50_staleness_min," +
      "p90_staleness_min,max_staleness_min";
    const body = summaries.map(({ channel, lead, summary: s, skill }) =>
      [
        channel,
        lead,
        s.targets,
        s.paired,
        s.coverage,
        s.mae,
        s.bias,
        s.rmse,
        s.p50AbsError,
        s.p90AbsError,
        s.maxAbsError,
        s.bandCoverage,
        s.advPredictedMae,
        skill?.skill ?? "",
        skill?.maePersistence ?? "",
        s.p50StalenessMin,
        s.p90StalenessMin,
        s.maxStalenessMin,
      ]
        .map((v) => (typeof v === "number" && !Number.isFinite(v) ? "" : v))
        .join(","),
    );
    writeOut(args.csv, [header, ...body].join("\n") + "\n");
  }
  if (args.csvPairs) writeOut(args.csvPairs, pairRows.join("\n") + "\n");
  if (args.json) console.log(JSON.stringify(summaries, null, 2));

  if (args.chart) {
    const { renderAccuracyChart } = await import("./forecast-accuracy-chart");
    const written = await renderAccuracyChart(args.chart, {
      title: `Amber forecast error vs lead — device ${device.rid} (${device.name})`,
      subtitle: `${aest(fromMs)} → ${aest(toMs)} AEST`,
      series: args.channels.map((channel) => ({
        channel,
        points: summaries
          .filter(
            (s) => s.channel === channel && Number.isFinite(s.summary.mae),
          )
          .map((s) => ({
            lead: s.lead,
            mae: s.summary.mae,
            p90: s.summary.p90AbsError,
            bias: s.summary.bias,
          })),
      })),
    });
    for (const f of written) console.log(`\nwrote ${f}`);
  }
}

function writeOut(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`\nwrote ${path}`);
}

// ── capture health ──────────────────────────────────────────────────────────────────────────────

/**
 * A gap beyond this is worth attributing. The poll is nominally 5-minutely but the schedule is
 * drift-based (`BaseVendorAdapter.evaluateSchedule`: fire at the first minutely cron tick where
 * `now − lastPollTime >= pollInterval − toleranceSeconds`, and Amber's tolerance is 60s), so
 * observed spacing legitimately ranges ~4.0-6.0 min. 7 clears that band without hiding anything.
 */
const POLL_GAP_THRESHOLD_MIN = 7;
const EXPECTED_POLLS_PER_HOUR = 12;

/**
 * `sessions.created_at` stamps the poll's START; `observed_at` is stamped mid-poll, ~1-5s later.
 * So the session that PRODUCED the capture closing a gap starts fractionally before it, and a naive
 * `created_at < gap_end` counts it as having run *inside* the gap — turning "the cron never fired"
 * into "a poll ran and captured nothing". Comfortably larger than the observed max poll duration
 * (1.7s) and orders of magnitude smaller than the gap threshold.
 */
const POLL_SETTLE_MS = 30_000;

async function reportHealth(
  db: Awaited<
    ReturnType<typeof import("@/lib/db/planetscale").requirePlanetscaleDb>
  >,
  sql: typeof import("drizzle-orm").sql,
  deviceRid: number,
  fromMs: number,
  toMs: number,
  rowsOf: <T>(res: unknown) => T[],
) {
  const from = toPgTimestamp(fromMs);
  const to = toPgTimestamp(toMs);

  const [overview] = rowsOf<{
    rows: string;
    polls: string;
    first_obs_ms: string | null;
    last_obs_ms: string | null;
    min_target_ms: string | null;
    max_target_ms: string | null;
  }>(
    await db.execute(sql`
      SELECT count(*) AS rows, count(DISTINCT observed_at) AS polls,
             (extract(epoch FROM min(observed_at)) * 1000)::bigint AS first_obs_ms,
             (extract(epoch FROM max(observed_at)) * 1000)::bigint AS last_obs_ms,
             (extract(epoch FROM min(interval_end)) * 1000)::bigint AS min_target_ms,
             (extract(epoch FROM max(interval_end)) * 1000)::bigint AS max_target_ms
      FROM amber_forecast_history
      WHERE device_rid = ${deviceRid}
        AND observed_at >= ${from}::timestamp AND observed_at <= ${to}::timestamp`),
  );

  console.log("\nCAPTURE HEALTH");
  const rows = Number(overview?.rows ?? 0);
  if (rows === 0) {
    console.log("  ✗ no forecast rows captured in this window.");
    process.exitCode = 1;
    return;
  }

  const firstObs = Number(overview.first_obs_ms);
  const lastObs = Number(overview.last_obs_ms);
  const captures = Number(overview.polls);
  const spanHours = Math.max((lastObs - firstObs) / HOUR_MS, 1 / 60);
  const ageMin = (Date.now() - lastObs) / 60_000;

  // `amber_forecast_history` only gets an `observed_at` when a poll INSERTS something, so counting
  // distinct observed_at counts CAPTURES, not polls: a poll that failed, or whose whole horizon
  // moved less than the 0.1 c/kWh threshold, leaves no trace at all. Reading the poll count from
  // `sessions` instead is what turns "11.9/h vs 12/h expected — is the logger sick?" into an
  // account that adds up. (Measured over the first 24h: 293 polls = 287 captures + 5 vendor 502s
  // + 1 empty poll, i.e. the threshold silences a whole poll roughly once in 300.)
  const [pollStats] = rowsOf<{
    polls: string;
    failed: string;
    top_error: string | null;
  }>(
    await db.execute(sql`
      SELECT count(*) AS polls,
             count(*) FILTER (WHERE NOT successful) AS failed,
             (SELECT left(error, 90) FROM sessions e
               WHERE e.device_rid = ${deviceRid} AND NOT e.successful AND e.error IS NOT NULL
                 AND e.created_at >= ${from}::timestamp AND e.created_at <= ${to}::timestamp
               GROUP BY left(error, 90) ORDER BY count(*) DESC LIMIT 1) AS top_error
      FROM sessions
      WHERE device_rid = ${deviceRid} AND cause = 'CRON'
        AND created_at >= ${toPgTimestamp(firstObs - POLL_SETTLE_MS)}::timestamp
        AND created_at <= ${toPgTimestamp(lastObs)}::timestamp`),
  );
  const polls = Number(pollStats?.polls ?? 0);
  const failed = Number(pollStats?.failed ?? 0);

  console.log(
    `  ${polls} polls run over ${spanHours.toFixed(1)}h ` +
      `(${(polls / spanHours).toFixed(2)}/h vs ${EXPECTED_POLLS_PER_HOUR}/h nominal, ` +
      `mean spacing ${((spanHours * 60) / Math.max(polls, 1)).toFixed(2)} min)` +
      (failed > 0 ? `  ⚠ ${failed} failed` : ""),
  );
  if (failed > 0 && pollStats.top_error) {
    console.log(`      most common error: ${pollStats.top_error}`);
  }
  console.log(
    `  ${captures} captures (${polls - captures} poll(s) recorded nothing), ` +
      `${rows.toLocaleString()} rows, ${(rows / Math.max(captures, 1)).toFixed(1)} rows/capture`,
  );
  console.log(
    `  observed ${aest(firstObs, true)} → ${aest(lastObs, true)}  (newest row ${ageMin.toFixed(0)} min old)`,
  );
  console.log(
    `  targets  ${aest(Number(overview.min_target_ms))} → ${aest(Number(overview.max_target_ms))}`,
  );

  // Amber's horizon is "today + tomorrow" in AEST days, not a rolling 48h, so the reach sawtooths
  // from ~36h down to ~14h across the AEST midnight boundary. Reporting min/max makes an actual
  // horizon change distinguishable from that expected sawtooth.
  const [reach] = rowsOf<{ min_h: string; max_h: string }>(
    await db.execute(sql`
      SELECT min(extract(epoch FROM (interval_end - observed_at)) / 3600) AS min_h,
             max(extract(epoch FROM (interval_end - observed_at)) / 3600) AS max_h
      FROM amber_forecast_history
      WHERE device_rid = ${deviceRid}
        AND observed_at >= ${from}::timestamp AND observed_at <= ${to}::timestamp`),
  );
  console.log(
    `  horizon  ${Number(reach.min_h).toFixed(1)}h … ${Number(reach.max_h).toFixed(1)}h ahead of the poll`,
  );

  // Each gap is attributed against `sessions`: polls that RAN inside it mean the vendor or the
  // threshold ate the data, no polls at all means the cron never fired. Without that split every
  // gap looks like "the logger broke", and the two have completely different fixes.
  const gaps = rowsOf<{
    prev_ms: string;
    next_ms: string;
    gap_min: string;
    polls_inside: string;
    failed_inside: string;
    reason: string | null;
  }>(
    await db.execute(sql`
      WITH p AS (
        SELECT DISTINCT observed_at AS o FROM amber_forecast_history
        WHERE device_rid = ${deviceRid}
          AND observed_at >= ${from}::timestamp AND observed_at <= ${to}::timestamp
      ), d AS (
        SELECT o, lead(o) OVER (ORDER BY o) AS nxt FROM p
      ), g AS (
        SELECT o, nxt FROM d
        WHERE nxt IS NOT NULL AND nxt - o > ${POLL_GAP_THRESHOLD_MIN} * interval '1 minute'
      )
      SELECT (extract(epoch FROM g.o) * 1000)::bigint AS prev_ms,
             (extract(epoch FROM g.nxt) * 1000)::bigint AS next_ms,
             extract(epoch FROM (g.nxt - g.o)) / 60 AS gap_min,
             (SELECT count(*) FROM sessions s
               WHERE s.device_rid = ${deviceRid}
                 AND s.created_at > g.o
                 AND s.created_at < g.nxt - ${POLL_SETTLE_MS} * interval '1 millisecond') AS polls_inside,
             (SELECT count(*) FROM sessions s
               WHERE s.device_rid = ${deviceRid} AND NOT s.successful
                 AND s.created_at > g.o
                 AND s.created_at < g.nxt - ${POLL_SETTLE_MS} * interval '1 millisecond') AS failed_inside,
             (SELECT left(s.error, 70) FROM sessions s
               WHERE s.device_rid = ${deviceRid} AND s.error IS NOT NULL
                 AND s.created_at > g.o
                 AND s.created_at < g.nxt - ${POLL_SETTLE_MS} * interval '1 millisecond'
               ORDER BY s.created_at LIMIT 1) AS reason
      FROM g
      ORDER BY gap_min DESC`),
  );
  if (gaps.length === 0) {
    console.log(`  no capture gaps > ${POLL_GAP_THRESHOLD_MIN} min ✓`);
  } else {
    const lostMin = gaps.reduce((s, g) => s + Number(g.gap_min), 0);
    console.log(
      `  ⚠ ${gaps.length} capture gap(s) > ${POLL_GAP_THRESHOLD_MIN} min (${lostMin.toFixed(0)} min):`,
    );
    for (const g of gaps.slice(0, 10)) {
      const inside = Number(g.polls_inside);
      const failedInside = Number(g.failed_inside);
      const verdict =
        inside === 0
          ? "no poll ran — cron tick(s) missed"
          : failedInside > 0
            ? `${inside} poll(s) ran, ${failedInside} failed: ${g.reason ?? "unknown"}`
            : `${inside} poll(s) ran and captured nothing (sub-threshold)`;
      console.log(
        `      ${aest(Number(g.prev_ms), true)} → ${aest(Number(g.next_ms), true)}  ` +
          `${Number(g.gap_min).toFixed(1)} min — ${verdict}`,
      );
    }
    if (gaps.length > 10) console.log(`      … and ${gaps.length - 10} more`);
  }

  const breakdown = rowsOf<{
    channel: string;
    interval_type: string;
    n: string;
    targets: string;
    with_price: string;
    with_band: string;
  }>(
    await db.execute(sql`
      SELECT channel, interval_type, count(*) AS n, count(DISTINCT interval_end) AS targets,
             count(per_kwh) AS with_price, count(adv_predicted) AS with_band
      FROM amber_forecast_history
      WHERE device_rid = ${deviceRid}
        AND observed_at >= ${from}::timestamp AND observed_at <= ${to}::timestamp
      GROUP BY 1, 2 ORDER BY 1, 2`),
  );
  console.log("\n  channel         type    rows  targets  w/price   w/band");
  for (const b of breakdown) {
    console.log(
      `  ${b.channel.padEnd(15)} ${b.interval_type.padEnd(4)} ` +
        `${Number(b.n).toLocaleString().padStart(7)}  ${String(b.targets).padStart(7)}  ` +
        `${String(b.with_price).padStart(7)}  ${String(b.with_band).padStart(7)}`,
    );
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
