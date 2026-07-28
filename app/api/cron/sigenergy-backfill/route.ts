import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { SystemsManager, type SystemWithPolling } from "@/lib/systems-manager";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { getSystemCredentials } from "@/lib/secure-credentials";
import { parseDateISO } from "@/lib/date-utils";
import { aggregateRange } from "@/lib/aggregation/daily-points";
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
 *   { systemId?: number, start?: "YYYY-MM-DD", end?: "YYYY-MM-DD", days?: number, dryRun?: boolean }
 *   - systemId: one sigenergy system; omit to run EVERY active sigenergy system (the cron default).
 *   - start/end: inclusive station-local calendar dates; if omitted, the last `days` (default 7).
 *
 * The default 7-day window makes each run self-healing over the trailing week, so a single missed
 * run costs nothing. Overlapping windows upsert (idempotent receiver), they don't duplicate.
 *
 *   curl -X POST .../api/cron/sigenergy-backfill \
 *     -H "Authorization: Bearer $CRON_SECRET" -d '{"days":7}'
 *   curl "http://localhost:3000/api/cron/sigenergy-backfill?days=2&dryRun=true" -H "x-claude: true"
 */

interface BackfillParams {
  systemId?: number;
  start?: string;
  end?: string;
  days?: number;
  dryRun?: boolean;
}

/** One system's outcome. `ok: false` carries `error` instead of a backfill result. */
type SystemOutcome = {
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
const ymdToIso = (y: string) =>
  `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;

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
  system: SystemWithPolling,
  params: BackfillParams,
): { startYmd: string; endYmd: string } {
  const days = Math.max(1, Math.floor(params.days ?? DEFAULT_DAYS));
  const localNow = new Date(Date.now() + system.timezoneOffsetMin * 60 * 1000);
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

/** Backfill one system. Never throws — a failure is reported as `{ ok: false, error }`. */
async function backfillOneSystem(
  system: SystemWithPolling,
  params: BackfillParams,
): Promise<SystemOutcome> {
  const dryRun = params.dryRun ?? false;

  if (!system.vendorSiteId)
    return {
      systemId: system.id,
      ok: false,
      error: "no Sigenergy station id (vendorSiteId)",
    };
  if (!system.ownerClerkUserId)
    return {
      systemId: system.id,
      ok: false,
      error: "no owner (Sigenergy credentials required)",
    };

  const { startYmd, endYmd } = resolveWindow(system, params);
  if (endYmd < startYmd)
    return {
      systemId: system.id,
      ok: false,
      error: "end must be on or after start",
    };
  const span = spanDaysBetween(startYmd, endYmd);
  if (span > MAX_RANGE_DAYS)
    return {
      systemId: system.id,
      ok: false,
      error: `Range ${span}d exceeds ${MAX_RANGE_DAYS}d cap`,
    };

  // getSystemCredentials swallows its own failures and returns null, so this can't throw.
  const credentials = (await getSystemCredentials(
    system.ownerClerkUserId,
    system.id,
  )) as SigenergyCredentials | null;
  if (!credentials?.username || !credentials?.password)
    return {
      systemId: system.id,
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
    systemId: system.id,
    cause: dryRun ? "ADMIN-DRYRUN" : "ADMIN",
    started: new Date(),
  });
  const collector = createPollCollector();
  const startTime = Date.now();

  try {
    const result = await backfillEnergyRange({
      client,
      systemId: system.id,
      stationId: system.vendorSiteId,
      startDate: startYmd,
      endDate: endYmd,
      tzOffsetMin: system.timezoneOffsetMin,
      session,
      collector,
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
      systemId: system.id,
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
      systemId: system.id,
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
  // per-system error. The tz-dependent cases are re-checked inside backfillOneSystem.
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

  // Resolve the targets: an explicit systemId, else EVERY active sigenergy system. Looping by
  // default is deliberate — the old "exactly one, or 400" rule would have silently broken the
  // nightly cron the day a second Sigenergy site was added.
  const sm = SystemsManager.getInstance();
  const sigenSystems = (await sm.getActiveSystems()).filter(
    (s) => s.vendorType === "sigenergy",
  );
  let targets: SystemWithPolling[];
  if (params.systemId != null) {
    const one = sigenSystems.find((s) => s.id === params.systemId);
    if (!one)
      return NextResponse.json(
        { error: `No active sigenergy system with id ${params.systemId}` },
        { status: 404 },
      );
    targets = [one];
  } else {
    targets = sigenSystems;
  }

  // No sigenergy systems is a benign no-op for a scheduled run, not an error.
  if (targets.length === 0)
    return NextResponse.json({
      ok: true,
      systems: [],
      aggregated1d: false,
      message: "No active sigenergy systems",
    });

  const dryRun = params.dryRun ?? false;
  const outcomes: SystemOutcome[] = [];
  for (const system of targets) {
    outcomes.push(await backfillOneSystem(system, params));
  }

  // Rebuild 1d aggregates once, over the union of the touched windows. aggregateRange is fleet-wide
  // (and runs the HWS / run-period / battery-provenance + flow_attr heal passes), so calling it per
  // system would just repeat the same work.
  const succeeded = outcomes.filter((o) => o.ok && o.range);
  let aggregated1d = false;
  let aggregatedRange: { start: string; end: string } | undefined;
  if (!dryRun && succeeded.length > 0) {
    const startYmd = succeeded
      .map((o) => o.range!.start)
      .reduce((a, b) => (a < b ? a : b));
    const endYmd = succeeded
      .map((o) => o.range!.end)
      .reduce((a, b) => (a > b ? a : b));
    await aggregateRange(
      parseDateISO(ymdToIso(startYmd)),
      parseDateISO(ymdToIso(endYmd)),
    );
    aggregated1d = true;
    aggregatedRange = { start: startYmd, end: endYmd };
  }

  const ok = outcomes.every((o) => o.ok);
  return NextResponse.json(
    { ok, dryRun, aggregated1d, aggregatedRange, systems: outcomes },
    // Every target failed ⇒ 500 so a scheduled run surfaces as a failure. A partial failure stays
    // 200 with `ok: false` — the successful systems really were written.
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
