/**
 * Reads of `amber_forecast_history` — the server half of `GET /api/v4/devices/{id}/forecasts` and
 * so of `liveone device forecasts`.
 *
 * The SQL here moved verbatim from `scripts/amber/forecast-accuracy.ts`, which used to need a
 * minted prod role to run it. Scoring stays in `./forecast-accuracy.ts` (pure) and in the script;
 * this module only answers "what did Amber publish, and was the logger alive".
 *
 * Three reads:
 *   - {@link readInForce} — per lead, the revision in force at each interval's cutoff
 *     (`DISTINCT ON … observed_at <= cutoff`). The table is change-only, so "in force" means the
 *     last STORED row at or before the cutoff, however long before it that row was observed.
 *   - {@link readAsOf} — the whole curve as published at one instant, all channels incl. `site`.
 *   - {@link readCaptureHealth} — polls vs captures vs gaps, each gap attributed against `sessions`.
 *
 * `interval_end` and `observed_at` are naive-UTC `timestamp`s. Every epoch comes back through
 * `extract(epoch …)` rather than as a parsed Date, because node-pg parses a naive timestamp in the
 * PROCESS timezone and a laptop in Melbourne would shift every row by 10–11 h.
 */
import { sql, type SQL } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import type { LeadAnchor } from "./forecast-accuracy";
import type {
  WireAsOfRow,
  WireCaptureHealth,
  WireForecastRow,
  WireInForceChannel,
} from "./forecast-wire";

type Exec = { execute: (q: SQL) => Promise<unknown> };

const HOUR_MS = 3_600_000;

/**
 * A gap between captures beyond this is worth attributing. The poll is nominally 5-minutely but the
 * schedule is drift-based (`BaseVendorAdapter.evaluateSchedule`: fire at the first minutely cron
 * tick where `now − lastPollTime >= pollInterval − toleranceSeconds`, and Amber's tolerance is 60s),
 * so observed spacing legitimately ranges ~4.0-6.0 min. 7 clears that band without hiding anything.
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

const rowsOf = <T>(res: unknown): T[] =>
  ((res as { rows?: unknown[] }).rows ?? res) as T[];

const toPgTimestamp = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").replace("Z", "");

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown): string | null => (ms == null ? null : iso(ms));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

// ── in-force ────────────────────────────────────────────────────────────────────────────────────

/** Thrown by {@link readInForce} when `captured × leads` would exceed the caller's row budget. */
export class InForceTooLarge extends Error {
  constructor(
    readonly channel: string,
    readonly captured: number,
    readonly leads: number,
    readonly budget: number,
  ) {
    super(
      `${channel}: ${captured} captured intervals × ${leads} leads = ${captured * leads} rows, ` +
        `over the ${budget}-row budget left for this request — narrow the window, or split the leads ` +
        `(or channels) across requests`,
    );
  }
}

/**
 * Per lead, the revision in force at each interval's cutoff — `interval_end − lead` (anchor `end`)
 * or `interval_end − duration − lead` (anchor `start`). The same rule as `cutoffMsFor`, done in SQL
 * because the window can hold hundreds of thousands of revisions. One round trip per lead.
 */
export async function readInForce(
  opts: {
    deviceRid: number;
    channel: string;
    fromMs: number;
    toMs: number;
    leads: number[];
    anchor: LeadAnchor;
    /** Refuse (throw {@link InForceTooLarge}) before the lead scans if they could exceed this. */
    maxRows?: number;
  },
  exec?: Exec,
): Promise<WireInForceChannel> {
  const db = exec ?? requirePlanetscaleDb();
  const from = toPgTimestamp(opts.fromMs);
  const to = toPgTimestamp(opts.toMs);

  const captured = rowsOf<{ interval_end_ms: string }>(
    await db.execute(sql`
      SELECT DISTINCT (extract(epoch FROM interval_end) * 1000)::bigint AS interval_end_ms
      FROM amber_forecast_history
      WHERE device_rid = ${opts.deviceRid} AND channel = ${opts.channel}
        AND interval_end >= ${from}::timestamp
        AND interval_end <= ${to}::timestamp
      ORDER BY 1`),
  ).map((r) => iso(r.interval_end_ms));
  // Each lead returns at most one row per captured interval, so this bound is exact, and it is
  // checked before the expensive part rather than after the payload is already built.
  if (
    opts.maxRows !== undefined &&
    captured.length * opts.leads.length > opts.maxRows
  )
    throw new InForceTooLarge(
      opts.channel,
      captured.length,
      opts.leads.length,
      opts.maxRows,
    );

  const leads: WireInForceChannel["leads"] = [];
  for (const lead of opts.leads) {
    const rows = rowsOf<{
      interval_end_ms: string;
      observed_at_ms: string;
      duration_min: number;
      per_kwh: number | null;
      adv_low: number | null;
      adv_predicted: number | null;
      adv_high: number | null;
      descriptor: string | null;
      spike_status: string | null;
      interval_type: string;
    }>(
      await db.execute(sql`
        SELECT DISTINCT ON (interval_end)
               (extract(epoch FROM interval_end) * 1000)::bigint AS interval_end_ms,
               (extract(epoch FROM observed_at) * 1000)::bigint AS observed_at_ms,
               duration_min, per_kwh, adv_low, adv_predicted, adv_high,
               descriptor, spike_status, interval_type
        FROM amber_forecast_history
        WHERE device_rid = ${opts.deviceRid} AND channel = ${opts.channel}
          AND interval_end >= ${from}::timestamp
          AND interval_end <= ${to}::timestamp
          AND observed_at <= interval_end
            - ${opts.anchor === "start" ? sql`duration_min * interval '1 minute'` : sql`interval '0'`}
            - ${lead} * interval '1 hour'
        ORDER BY interval_end, observed_at DESC`),
    ).map(
      (r): WireForecastRow => ({
        intervalEnd: iso(r.interval_end_ms),
        observedAt: iso(r.observed_at_ms),
        durationMin: Number(r.duration_min),
        perKwh: numOrNull(r.per_kwh),
        advLow: numOrNull(r.adv_low),
        advPredicted: numOrNull(r.adv_predicted),
        advHigh: numOrNull(r.adv_high),
        descriptor: r.descriptor,
        spikeStatus: r.spike_status,
        intervalType: r.interval_type,
      }),
    );
    leads.push({ lead, rows });
  }
  return { channel: opts.channel, captured, leads };
}

// ── as-of ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The forecast curve as published at `atMs`: for every (channel, interval) ending within
 * `(atMs, atMs + horizon]`, the last revision observed at or before `atMs`. The step-function
 * reconstruction the schema comment describes, including the `site` rows.
 */
export async function readAsOf(
  opts: { deviceRid: number; atMs: number; horizonHours: number },
  exec?: Exec,
): Promise<WireAsOfRow[]> {
  const db = exec ?? requirePlanetscaleDb();
  const at = toPgTimestamp(opts.atMs);
  const until = toPgTimestamp(opts.atMs + opts.horizonHours * HOUR_MS);
  return rowsOf<{
    channel: string;
    interval_end_ms: string;
    observed_at_ms: string;
    duration_min: number;
    per_kwh: number | null;
    adv_low: number | null;
    adv_predicted: number | null;
    adv_high: number | null;
    descriptor: string | null;
    spike_status: string | null;
    interval_type: string;
    spot_per_kwh: number | null;
    renewables: number | null;
  }>(
    await db.execute(sql`
      SELECT DISTINCT ON (channel, interval_end)
             channel,
             (extract(epoch FROM interval_end) * 1000)::bigint AS interval_end_ms,
             (extract(epoch FROM observed_at) * 1000)::bigint AS observed_at_ms,
             duration_min, per_kwh, adv_low, adv_predicted, adv_high,
             descriptor, spike_status, interval_type, spot_per_kwh, renewables
      FROM amber_forecast_history
      WHERE device_rid = ${opts.deviceRid}
        AND interval_end > ${at}::timestamp
        AND interval_end <= ${until}::timestamp
        AND observed_at <= ${at}::timestamp
      ORDER BY channel, interval_end, observed_at DESC`),
  ).map((r) => ({
    channel: r.channel,
    intervalEnd: iso(r.interval_end_ms),
    observedAt: iso(r.observed_at_ms),
    durationMin: Number(r.duration_min),
    perKwh: numOrNull(r.per_kwh),
    advLow: numOrNull(r.adv_low),
    advPredicted: numOrNull(r.adv_predicted),
    advHigh: numOrNull(r.adv_high),
    descriptor: r.descriptor,
    spikeStatus: r.spike_status,
    intervalType: r.interval_type,
    spotPerKwh: numOrNull(r.spot_per_kwh),
    renewables: numOrNull(r.renewables),
  }));
}

// ── capture health ──────────────────────────────────────────────────────────────────────────────

/**
 * Is the logger alive over this window — and if not, whose fault? A silent capture outage and a
 * genuinely unchanging forecast look identical in a change-only table; only the poll record in
 * `sessions` tells them apart.
 */
export async function readCaptureHealth(
  opts: { deviceRid: number; fromMs: number; toMs: number; nowMs: number },
  exec?: Exec,
): Promise<WireCaptureHealth> {
  const db = exec ?? requirePlanetscaleDb();
  const deviceRid = opts.deviceRid;
  const from = toPgTimestamp(opts.fromMs);
  const to = toPgTimestamp(opts.toMs);

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

  const rows = Number(overview?.rows ?? 0);
  const empty: WireCaptureHealth = {
    rows: 0,
    captures: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    minTarget: null,
    maxTarget: null,
    newestAgeMin: null,
    polls: 0,
    failedPolls: 0,
    topError: null,
    expectedPollsPerHour: EXPECTED_POLLS_PER_HOUR,
    horizonMinHours: null,
    horizonMaxHours: null,
    gapThresholdMin: POLL_GAP_THRESHOLD_MIN,
    gaps: [],
    breakdown: [],
  };
  if (rows === 0) return empty;

  const firstObs = Number(overview.first_obs_ms);
  const lastObs = Number(overview.last_obs_ms);

  // `amber_forecast_history` only gets an `observed_at` when a poll INSERTS something, so counting
  // distinct observed_at counts CAPTURES, not polls: a poll that failed, or whose whole horizon
  // moved less than the 0.1 c/kWh threshold, leaves no trace at all. Reading the poll count from
  // `sessions` instead is what turns "11.9/h vs 12/h expected — is the logger sick?" into an
  // account that adds up.
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

  // Amber's horizon is "today + tomorrow" in AEST days, not a rolling 48h, so the reach sawtooths
  // from ~36h down to ~14h across the AEST midnight boundary.
  const [reach] = rowsOf<{ min_h: string | null; max_h: string | null }>(
    await db.execute(sql`
      SELECT min(extract(epoch FROM (interval_end - observed_at)) / 3600) AS min_h,
             max(extract(epoch FROM (interval_end - observed_at)) / 3600) AS max_h
      FROM amber_forecast_history
      WHERE device_rid = ${deviceRid}
        AND observed_at >= ${from}::timestamp AND observed_at <= ${to}::timestamp`),
  );

  // Each gap is attributed against `sessions`: polls that RAN inside it mean the vendor or the
  // threshold ate the data, no polls at all means the cron never fired.
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

  return {
    ...empty,
    rows,
    captures: Number(overview.polls),
    firstObservedAt: iso(firstObs),
    lastObservedAt: iso(lastObs),
    minTarget: isoOrNull(overview.min_target_ms),
    maxTarget: isoOrNull(overview.max_target_ms),
    newestAgeMin: Math.round((opts.nowMs - lastObs) / 60_000),
    polls: Number(pollStats?.polls ?? 0),
    failedPolls: Number(pollStats?.failed ?? 0),
    topError: pollStats?.top_error ?? null,
    horizonMinHours: numOrNull(reach?.min_h),
    horizonMaxHours: numOrNull(reach?.max_h),
    gaps: gaps.map((g) => {
      const pollsInside = Number(g.polls_inside);
      const failedInside = Number(g.failed_inside);
      return {
        prev: iso(g.prev_ms),
        next: iso(g.next_ms),
        gapMin: Math.round(Number(g.gap_min) * 10) / 10,
        pollsInside,
        failedInside,
        reason: g.reason,
        verdict:
          pollsInside === 0
            ? "cron-missed"
            : failedInside > 0
              ? "failed"
              : "sub-threshold",
      };
    }),
    breakdown: breakdown.map((b) => ({
      channel: b.channel,
      intervalType: b.interval_type,
      rows: Number(b.n),
      targets: Number(b.targets),
      withPrice: Number(b.with_price),
      withBand: Number(b.with_band),
    })),
  };
}
