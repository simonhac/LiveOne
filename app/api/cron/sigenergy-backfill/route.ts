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
import { healStaleAgg1dForDevice } from "@/lib/aggregation/heal-stale-agg1d";
import { ReadingsDao } from "@/lib/readings";
import {
  waitForLanding,
  landingScopeFor,
  type LandingScope,
} from "@/lib/observations/landing";
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
 * route runs. `/api/cron/repair-coverage` is only the backstop. (Before this was scheduled, that
 * backstop's `graceDays: 7` was the sole writer, which left the Kutis energy series structurally
 * 7–14 days stale.)
 *
 * 🛑 **This route must run BEFORE `/api/cron/daily`, and the schedules in `vercel.json` are load-
 * bearing for that reason** (00:05 vs 00:35 local; they are listed there in execution order). It used
 * to be the other way round — daily at 00:05, this at 00:20 — which meant `cron/daily` rolled up
 * "yesterday" for a Sigenergy device 15 minutes before yesterday's energy existed, every single
 * night. The consequence was not a slow correction but a SINGLE POINT OF FAILURE: this route's own
 * scoped recompute was the only thing that ever made a Sigenergy daily total right, so one bad
 * landing left the day wrong permanently, and nothing downstream disagreed. Running first restores
 * the redundancy the fleet sweep is supposed to provide.
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
  /**
   * Exactly what this run put on the wire: the points, the interval range, and the DISTINCT row
   * count the landing wait counts up to. Read off the collector, which has already de-duplicated by
   * address, so no separate tally can drift from it — and scoped to the published points/range, so
   * an unrelated write has far less chance of satisfying the target on our behalf.
   */
  landingScope?: LandingScope;
  /** False when the landing wait gave up. The recompute is then SKIPPED — see the wait. */
  landed?: boolean;
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

/**
 * How long to wait for the published 5m rows to land before recomputing from them.
 *
 * Raising this is nearly free now that the wait has an EXACT stop condition: it returns the moment
 * the published row count is met, so a longer deadline costs nothing on a healthy run and only buys
 * patience on a slow one. When it was a watermark the wait ended on the first row regardless, so the
 * number was never the thing that mattered.
 */
const LANDING_WAIT_MS = 120_000;
const LANDING_POLL_MS = 3_000;

/** A device's points, as reading-DAO ids. Empty when the device has none yet. */
async function pointIdsFor(systemId: number) {
  const map = await PointManager.getInstance().loadPointInfoMap(systemId);
  return Object.values(map).map((p) => Point.encode(p.pointUid));
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
  const collector = createPollCollector({ lane: "backfill" });
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

    // Read off the collector rather than from `result`: the collector is what the publisher flushes,
    // and a count derived from anything else could disagree with what the receiver is about to
    // write. Taken before the flush only because the buffer is final here; it needs no baseline,
    // because the scope carries the session ids that identify our landings.
    const landingScope = dryRun
      ? undefined
      : landingScopeFor(collector.observations);

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
      dryRun ? createPollCollector({ lane: collector.lane }) : collector,
    );

    return {
      systemId: device.id,
      ok: result.errors.length === 0,
      error: result.errors.length ? result.errors.join("; ") : undefined,
      sessionId: session.id,
      range: { start: startYmd, end: endYmd },
      landingScope,
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
      dryRun ? createPollCollector({ lane: collector.lane }) : collector,
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

  // Heal days a PREVIOUS run left with a stale `agg_1d` — a landing that timed out (whose recompute
  // this route now deliberately skips), a crash between the two writes, or the old sign-of-life wait
  // that used to recompute over a half-landed store. Nothing else in the system revisits a past day,
  // so without this a wrong day is permanent.
  //
  // Deliberately BEFORE the fetch, not after: it reads only committed state, so it is race-free
  // here, and running it first means a fetch that spends the budget cannot starve it. Best-effort —
  // it never throws, and never blocks the backfill.
  const healed: Record<number, string[]> = {};
  if (!dryRun && planetscaleDb) {
    for (const device of targets) {
      const r = await healStaleAgg1dForDevice(planetscaleDb, device, {
        lookbackDays: params.days ?? DEFAULT_DAYS,
        label: "SigenBackfill",
      });
      if (r.healed.length > 0) healed[device.id] = r.healed;
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
    //
    // 🛑 **Wait for a COUNT, not for a sign of life.** This used to compare `MAX(updated_at)`
    // against a pre-flush baseline and stop the moment it advanced — which is the first row of the
    // first message, not the last row of the last. A 7-day window is ~12k observations, chunked at
    // 500 per message and delivered on the `backfill` lane at parallelism 2, so "something landed"
    // is true within a second and stays true for the whole delivery. The recompute then read a
    // half-landed store and wrote the half into `agg_1d`. That is what left Kutis' 2026-09-09 daily
    // totals at solar 0 Wh and load 1,860 Wh while the 5-minute rows summed to 35,330 and 20,210 —
    // wrong for two days, self-consistent, and invisible to everything downstream.
    //
    // The publisher knows how many DISTINCT rows it sent, so the stop condition is that many rows
    // updated at or after the baseline. Rows another writer touches in the same window also count,
    // so the test is `>=` and can only end the wait early in the case where extra real writes are
    // arriving anyway — unlike the watermark, which ended it early always.
    const wait = await waitForLanding({
      targets: succeeded.map((o) => ({
        key: String(o.systemId),
        expected: o.landingScope?.expected ?? 0,
      })),
      countLanded: (key) => {
        const o = succeeded.find((x) => String(x.systemId) === key)!;
        return ReadingsDao.countAgg5mForSessions(o.landingScope!.points, {
          afterIntervalEndMs: o.landingScope!.fromMs,
          throughIntervalEndMs: o.landingScope!.toMs,
          sessionIds: o.landingScope!.sessionIds,
        });
      },
      timeoutMs: LANDING_WAIT_MS,
      pollMs: LANDING_POLL_MS,
    });

    // 🛑 A device that did not land is SKIPPED, not recomputed anyway. Recomputing over a store we
    // know is incomplete writes a wrong day on purpose; skipping leaves whatever was there, and the
    // stale sweep at the top of the next run rebuilds it — which is why that sweep is not optional.
    const stranded = new Set(wait.pending);
    for (const o of succeeded) {
      o.landed = !stranded.has(String(o.systemId));
      if (!o.landed)
        console.error(
          `[SigenBackfill] system ${o.systemId}: landing incomplete after ${wait.waitedMs}ms ` +
            `(${wait.observed.get(String(o.systemId)) ?? 0}/${o.landingScope?.expected ?? 0} rows) — ` +
            `SKIPPING the agg_1d recompute so a partial day is not written. The next run's stale ` +
            `sweep rebuilds it.`,
        );
    }

    recompute = { agg1dDays: 0, provenanceAreas: 0 };
    for (const o of succeeded) {
      if (o.landed === false) continue;
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
    {
      ok,
      dryRun,
      aggregated1d,
      aggregatedRange,
      recompute,
      // Empty on a healthy fleet. A device appearing here repeatedly means its landing keeps timing
      // out — the sweep is papering over something, and the log lines above name it.
      healedStaleDays: Object.keys(healed).length > 0 ? healed : undefined,
      devices: outcomes,
    },
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
