import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import {
  DeviceConfigRegistry,
  type DeviceConfigView,
} from "@/lib/registry/device-config";
import { sessionManager } from "@/lib/session-manager";
import { PointManager } from "@/lib/point/point-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { planetscaleDb } from "@/lib/db/planetscale";
import { recomputeDerivedForDeviceDays } from "@/lib/aggregation/scoped-recompute";
import { ReadingsDao } from "@/lib/readings";
import { Point } from "@/lib/ids";
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
 * THIS IS THE PRIMARY PATH, not a repair tool. `SigenergyAdapter` emits power + SoC only, so Sigenergy
 * is the one vendor whose interval energy never arrives on the live poll — it exists only because this
 * route runs. It is scheduled daily in `vercel.json` just after `/api/cron/daily`; the weekly
 * `/api/cron/repair-coverage` is only the backstop. (Before it was scheduled, that backstop's
 * `graceDays: 7` was the sole writer, which left the Kutis energy series structurally 7–14 days stale.)
 *
 * Lives under /api/cron/* (a Clerk-public prefix) so it is reachable by an
 * `Authorization: Bearer $CRON_SECRET` curl (or `x-claude: true` in dev); `requireCronOrAdmin` also
 * accepts an admin session. Writes energy 5m through the normal queue → single-writer receiver, then
 * rebuilds 1d for the range.
 *
 * Params (GET query string, or POST JSON body):
 *   { systemId?: number, start?: "YYYY-MM-DD", end?: "YYYY-MM-DD", days?: number, dryRun?: boolean,
 *     raw?: boolean }
 *   - systemId: one sigenergy device; omit to run EVERY active sigenergy device (the cron default).
 *   - start/end: inclusive station-local calendar dates; if omitted, the last `days` (default 7).
 *
 * The default 7-day window makes each run self-healing over the trailing week, so a single missed
 * run costs nothing. Overlapping windows upsert (idempotent receiver), they don't duplicate.
 *
 *   curl -X POST .../api/cron/sigenergy-backfill \
 *     -H "Authorization: Bearer $CRON_SECRET" -d '{"days":7}'
 *   curl "http://localhost:3000/api/cron/sigenergy-backfill?days=2&dryRun=true" -H "x-claude: true"
 *
 * `raw=true` (single day only) returns the vendor's verbatim statistics payload alongside the
 * counts. The differenced output cannot answer questions about its own INPUT — the cumulative
 * counters occasionally drop to ~0 for one sample, and a stored delta cannot say whether the vendor
 * sent that zero or we coerced a non-numeric sentinel into one. Nothing archives the payload, so
 * reading it back is the only way to look:
 *
 *   npm run liveone -- api "/api/cron/sigenergy-backfill?start=2026-08-20&end=2026-08-20\
 *     &dryRun=true&raw=true"
 *
 * See `docs/plans/sigenergy-counter-dropout-forensics.md`.
 */

interface BackfillParams {
  systemId?: number;
  start?: string;
  end?: string;
  days?: number;
  dryRun?: boolean;
  /** Diagnostics: return the vendor's verbatim statistics payload. Single-day ranges only. */
  raw?: boolean;
}

/** One device's outcome. `ok: false` carries `error` instead of a backfill result. */
type DeviceOutcome = {
  systemId: number;
  ok: boolean;
  error?: string;
  sessionId?: string;
  range?: { start: string; end: string };
} & Partial<Awaited<ReturnType<typeof backfillEnergyRange>>>;

const ymd = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;

const parseToYmd = (iso: string) => iso.replace(/-/g, "");

function spanDaysBetween(startYmd: string, endYmd: string): number {
  const toUtc = (y: string) =>
    Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8));
  return (
    Math.round((toUtc(endYmd) - toUtc(startYmd)) / (24 * 60 * 60 * 1000)) + 1
  );
}

/**
 * Resolve the station-local calendar window for one system. Explicit start/end are timezone-free;
 * only the `days` fallback needs the station's offset, which is why this is per-system.
 */
function resolveWindow(
  device: DeviceConfigView,
  params: BackfillParams,
): { startYmd: string; endYmd: string } {
  const days = Math.max(1, Math.floor(params.days ?? DEFAULT_DAYS));
  const localNow = new Date(Date.now() + device.timezoneOffsetMin * 60 * 1000);
  if (params.start || params.end) {
    const endYmd = params.end ? parseToYmd(params.end) : ymd(localNow);
    return {
      startYmd: params.start ? parseToYmd(params.start) : endYmd,
      endYmd,
    };
  }
  const startD = new Date(localNow);
  startD.setUTCDate(startD.getUTCDate() - (days - 1));
  return { startYmd: ymd(startD), endYmd: ymd(localNow) };
}

/** Inclusive local days between two YYYYMMDD bounds, as "YYYY-MM-DD". */
function eachIsoDay(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  const toMs = (y: string) =>
    Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8));
  for (let ms = toMs(startYmd); ms <= toMs(endYmd); ms += 24 * 3600 * 1000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

/** How long to wait for the published 5m rows to land before recomputing from them. */
const LANDING_WAIT_MS = 60_000;
const LANDING_POLL_MS = 3_000;

/** A device's points, as reading-DAO ids. Empty when the device has none yet. */
async function pointIdsFor(systemId: number) {
  const map = await PointManager.getInstance().loadPointInfoMap(systemId);
  return Object.values(map).map((p) => Point.encode(p.pointUid));
}

/**
 * `MAX(updated_at)` across a device's 5m rows — the landing watermark.
 *
 * Compared against a baseline taken BEFORE the queue flush, so both readings come from the database
 * clock and app/DB skew cannot make a stale read look fresh. A window this wide is still an indexed
 * `(point_rid, interval_end)` range scan.
 */
async function landingWatermark(
  systemId: number,
  windowMs: { fromMs: number; toMs: number },
): Promise<number | null> {
  const points = await pointIdsFor(systemId);
  if (points.length === 0) return null;
  return ReadingsDao.latestAgg5mUpdatedAtForPoints(points, {
    afterIntervalEndMs: windowMs.fromMs,
    throughIntervalEndMs: windowMs.toMs,
  });
}

/** Backfill one system. Never throws — a failure is reported as `{ ok: false, error }`. */
async function backfillOneDevice(
  device: DeviceConfigView,
  params: BackfillParams,
): Promise<DeviceOutcome> {
  const dryRun = params.dryRun ?? false;

  if (!device.vendorSiteId)
    return {
      systemId: device.id,
      ok: false,
      error: "no Sigenergy station id (vendorSiteId)",
    };
  if (!device.ownerClerkUserId)
    return {
      systemId: device.id,
      ok: false,
      error: "no owner (Sigenergy credentials required)",
    };

  const { startYmd, endYmd } = resolveWindow(device, params);
  if (endYmd < startYmd)
    return {
      systemId: device.id,
      ok: false,
      error: "end must be on or after start",
    };
  const span = spanDaysBetween(startYmd, endYmd);
  if (span > MAX_RANGE_DAYS)
    return {
      systemId: device.id,
      ok: false,
      error: `Range ${span}d exceeds ${MAX_RANGE_DAYS}d cap`,
    };

  // getDeviceCredentials swallows its own failures and returns null, so this can't throw.
  const credentials = (await getDeviceCredentials(
    device.ownerClerkUserId,
    device.id,
  )) as SigenergyCredentials | null;
  if (!credentials?.username || !credentials?.password)
    return {
      systemId: device.id,
      ok: false,
      error: "no Sigenergy credentials",
    };

  const client = new SigenergyClient({
    username: credentials.username,
    password: credentials.password,
    region: credentials.region ?? "aus",
  });

  const session = await sessionManager.createSession({
    sessionLabel: "sigen-energy-backfill",
    systemId: device.id,
    cause: dryRun ? "ADMIN-DRYRUN" : "ADMIN",
    started: new Date(),
  });
  const collector = createPollCollector();
  const startTime = Date.now();

  try {
    const result = await backfillEnergyRange({
      client,
      systemId: device.id,
      stationId: device.vendorSiteId,
      startDate: startYmd,
      endDate: endYmd,
      tzOffsetMin: device.timezoneOffsetMin,
      session,
      collector,
      includeRaw: params.raw ?? false,
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

    return {
      systemId: device.id,
      ok: result.errors.length === 0,
      error: result.errors.length ? result.errors.join("; ") : undefined,
      sessionId: session.id,
      range: { start: startYmd, end: endYmd },
      ...result,
    };
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
    return {
      systemId: device.id,
      ok: false,
      error: message,
      sessionId: session.id,
      range: { start: startYmd, end: endYmd },
    };
  }
}

async function handleBackfill(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const skip = cronSkipReason(request, auth);
  if (skip) return NextResponse.json(skip);

  // Params come from the query string (GET — how Vercel fires the cron) or the JSON body (POST).
  let params: BackfillParams;
  if (request.method === "POST") {
    params = await request.json().catch(() => ({}));
  } else {
    const q = request.nextUrl.searchParams;
    const num = (v: string | null) => (v == null ? undefined : Number(v));
    params = {
      systemId: num(q.get("systemId")),
      start: q.get("start") ?? undefined,
      end: q.get("end") ?? undefined,
      days: num(q.get("days")),
      dryRun: q.get("dryRun") === "true",
      raw: q.get("raw") === "true",
    };
  }
  if (params.systemId != null && !Number.isFinite(params.systemId))
    return NextResponse.json(
      { error: "systemId must be a number" },
      { status: 400 },
    );
  if (params.days != null && !Number.isFinite(params.days))
    return NextResponse.json(
      { error: "days must be a number" },
      { status: 400 },
    );

  // Request-level range validation (timezone-free cases) so client mistakes get a 400, not a
  // per-device error. The tz-dependent cases are re-checked inside backfillOneDevice.
  if (params.start && params.end) {
    const s = parseToYmd(params.start);
    const e = parseToYmd(params.end);
    if (e < s)
      return NextResponse.json(
        { error: "end must be on or after start" },
        { status: 400 },
      );
    const span = spanDaysBetween(s, e);
    if (span > MAX_RANGE_DAYS)
      return NextResponse.json(
        { error: `Range ${span}d exceeds ${MAX_RANGE_DAYS}d cap` },
        { status: 400 },
      );
  }
  if (params.days != null && params.days > MAX_RANGE_DAYS)
    return NextResponse.json(
      { error: `Range ${params.days}d exceeds ${MAX_RANGE_DAYS}d cap` },
      { status: 400 },
    );

  // `raw` is bounded to ONE day: the payload is ~288 itemList rows, so the default 7-day window
  // would return roughly 2000 of them and make the diagnostic unreadable in the same breath as
  // making the response large. Asking for a specific day is also the only sensible way to use it —
  // you are looking AT something.
  if (params.raw) {
    const span =
      params.start && params.end
        ? spanDaysBetween(parseToYmd(params.start), parseToYmd(params.end))
        : params.start || params.end
          ? 1
          : (params.days ?? DEFAULT_DAYS);
    if (span !== 1)
      return NextResponse.json(
        {
          error:
            "raw=true needs a single day — pass start=YYYY-MM-DD&end=<same>, or days=1",
        },
        { status: 400 },
      );
  }

  // Resolve the targets: an explicit systemId, else EVERY active sigenergy system. Looping by
  // default is deliberate — the old "exactly one, or 400" rule would have silently broken the
  // nightly cron the day a second Sigenergy site was added.
  const sigenDevices = (await DeviceConfigRegistry.activeDevices()).filter(
    (s) => s.vendorType === "sigenergy",
  );
  let targets: DeviceConfigView[];
  if (params.systemId != null) {
    const one = sigenDevices.find((s) => s.id === params.systemId);
    if (!one)
      return NextResponse.json(
        { error: `No active sigenergy system with id ${params.systemId}` },
        { status: 404 },
      );
    targets = [one];
  } else {
    targets = sigenDevices;
  }

  // No sigenergy devices is a benign no-op for a scheduled run, not an error.
  if (targets.length === 0)
    return NextResponse.json({
      ok: true,
      devices: [],
      aggregated1d: false,
      message: "No active sigenergy systems",
    });

  const dryRun = params.dryRun ?? false;

  // The landing baseline must predate the queue flush that `backfillOneDevice` performs, so it is
  // taken here rather than after the loop.
  const landingWindow = {
    fromMs: Date.now() - 400 * 24 * 3600 * 1000,
    toMs: Date.now() + 24 * 3600 * 1000,
  };
  const baselines = new Map<number, number | null>();
  if (!dryRun) {
    for (const device of targets) {
      try {
        baselines.set(
          device.id,
          await landingWatermark(device.id, landingWindow),
        );
      } catch {
        baselines.set(device.id, null); // unknown baseline ⇒ the wait below just times out
      }
    }
  }

  const outcomes: DeviceOutcome[] = [];
  for (const device of targets) {
    outcomes.push(await backfillOneDevice(device, params));
  }

  // Rebuild the derived tables for the days we actually touched.
  //
  // This used to call the fleet-wide `aggregateRange`, which rebuilds agg_1d for EVERY device over
  // the range and then re-runs HWS, battery learning, provenance, run periods and two backlog reheal
  // passes — most of them from the range start to now, none of them scoped to this device. Measured
  // on prod: a ONE-DAY run spent the whole 300 s `maxDuration` in it and returned an empty response,
  // so every nightly run was timing out, burning a full invocation and reporting nothing. The writes
  // were unaffected only because the queue flush happens before this point.
  //
  // The scoped version does the work that actually follows from "this device's days changed", shared
  // with the coverage-repair runner. The fleet backlog remains `cron/daily`'s job.
  const succeeded = outcomes.filter((o) => o.ok && o.range);
  let aggregated1d = false;
  let aggregatedRange: { start: string; end: string } | undefined;
  let recompute: { agg1dDays: number; provenanceAreas: number } | undefined;
  if (!dryRun && succeeded.length > 0 && planetscaleDb) {
    const startYmd = succeeded
      .map((o) => o.range!.start)
      .reduce((a, b) => (a < b ? a : b));
    const endYmd = succeeded
      .map((o) => o.range!.end)
      .reduce((a, b) => (a > b ? a : b));

    // The 5m rows are published to a queue and land asynchronously, so recomputing immediately would
    // read pre-backfill data. That race existed before, but the old fleet-wide pass was slow enough
    // to hide it — making the recompute fast is exactly what exposes it, so the wait is part of this
    // change, not an extra.
    const deadline = Date.now() + LANDING_WAIT_MS;
    const awaiting = new Set(succeeded.map((o) => o.systemId));
    while (awaiting.size > 0 && Date.now() < deadline) {
      for (const sid of [...awaiting]) {
        const base = baselines.get(sid);
        try {
          const now = await landingWatermark(sid, landingWindow);
          if (now != null && (base == null || now > base)) awaiting.delete(sid);
        } catch {
          // Transient read failure — keep waiting; the deadline bounds it.
        }
      }
      if (awaiting.size === 0) break;
      await new Promise((r) => setTimeout(r, LANDING_POLL_MS));
    }

    recompute = { agg1dDays: 0, provenanceAreas: 0 };
    for (const o of succeeded) {
      const device = targets.find((d) => d.id === o.systemId);
      if (!device) continue;
      const r = await recomputeDerivedForDeviceDays(
        planetscaleDb,
        device,
        eachIsoDay(o.range!.start, o.range!.end),
        Date.now(),
        "SigenBackfill",
      );
      recompute.agg1dDays += r.agg1dDays;
      recompute.provenanceAreas += r.provenanceAreas;
    }
    aggregated1d = recompute.agg1dDays > 0;
    aggregatedRange = { start: startYmd, end: endYmd };
  }

  const ok = outcomes.every((o) => o.ok);
  return NextResponse.json(
    { ok, dryRun, aggregated1d, aggregatedRange, recompute, devices: outcomes },
    // Every target failed ⇒ 500 so a scheduled run surfaces as a failure. A partial failure stays
    // 200 with `ok: false` — the successful devices really were written.
    { status: succeeded.length === 0 ? 500 : 200 },
  );
}

// Vercel crons issue GET; POST stays for manual/scripted invocation with a JSON body.
export async function GET(request: NextRequest) {
  return handleBackfill(request);
}

export async function POST(request: NextRequest) {
  return handleBackfill(request);
}
