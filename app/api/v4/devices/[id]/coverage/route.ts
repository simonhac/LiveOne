import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/api-auth";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices as devicesTable } from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";
import { parseDate } from "@internationalized/date";
import { splitBraceAware } from "@/lib/series-filter-utils";
import { buildDeviceCoverage } from "@/lib/coverage/report";

/**
 * `GET /api/v4/devices/{id}/coverage` — how many 5-minute rows each of a device's points actually
 * holds, per local day, over a window. The operator read behind `liveone device coverage`.
 *
 * This answers a question the system already asks itself nightly and no operator could reach: the
 * coverage-repair cron runs the same `count(*) … group by local_day`
 * (`ReadingsDao.countAgg5mByLocalDay` → `lib/coverage/find-gaps.ts`) to decide what to re-fetch, but
 * only for the three vendors whose gaps ARE re-fetchable, only on a schedule, and it reports into
 * Slack rather than to a caller. Everything here is read-only and vendor-agnostic, so it also covers
 * the push vendors the cron excludes by design — the case where a device can go dark for months and
 * nothing says so.
 *
 * 🛑 Deliberately NOT `?list=…` on `/api/history`. That route's readability gate is
 * `requireDashboardAccess` and its `maxDuration` is 30s and shared with every chart the app draws;
 * this is an operator read with a different cost profile, and it must answer for an ARCHIVED device
 * (see the auth note below), which the chart path has no reason to do.
 *
 * ⚠️ Cost: one grouped count over `point_readings_agg_5m` for every selected point across the
 * window. It is an index-only range scan on the `(point_rid, interval_end)` PK, but a year of a
 * 40-point device is still millions of index entries — hence the explicit window (no default that
 * silently sweeps all history) and `--series` on the caller. `?list=series&samples=true` on
 * `/api/history` 504'd for exactly this reason once; that scan was unbounded, this one is not.
 */
export const maxDuration = 60;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** The same ceiling `last=Nd` accepts — an explicit window must not be a way around it. */
const MAX_SPAN_DAYS = 3660;

/**
 * A real calendar date, not merely a `\d{4}-\d{2}-\d{2}` shape.
 *
 * 🛑 The regex admits `2026-02-30`, and `parseDate` THROWS on it — an uncaught 500 from a request
 * that looks well-formed. The CLI's own `V.date` catches this client-side, which is exactly why the
 * route cannot rely on it: this address is reachable directly by anything holding a token.
 */
function validDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  try {
    return parseDate(day).toString() === day;
  } catch {
    return false;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid)
    return NextResponse.json(
      { error: `Invalid device id: ${id}` },
      { status: 400 },
    );

  const [row] = await requirePlanetscaleDb()
    .select()
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  if (!row)
    return NextResponse.json({ error: "Device not found" }, { status: 404 });

  // 🛑 The SAME readable set as `GET /api/v4/devices` and the per-device aggregate — owned ∪ public
  // ∪ dashboard-granted, widened by `x-liveone-admin` only when the caller asked — with
  // `activeOnly` off, because coverage is exactly the question you ask about a device that has
  // STOPPED, including one since archived.
  //
  // Deliberately NOT `requireDeviceAccess`, which looked like the obvious fit (it has no status
  // filter) but is a DIFFERENT set in two ways that would both surprise: it omits the
  // dashboard-grant term, so a grantee who can run `device show` would get 403 here; and it keys on
  // `ctx.isAdmin` rather than `actingAsAdmin`, so an admin would read any device's coverage without
  // the `--admin` opt-in that every neighbouring read requires. Being an admin is not acting as one.
  const visible = await DeviceConfigRegistry.devicesVisibleByUser(
    auth.userId,
    false,
    { isAdmin: auth.actingAsAdmin },
  );
  // Unknown and not-readable collapse into the SAME 404, exactly as the aggregate route does, so
  // this is not an existence oracle over other owners' device ids.
  if (!visible.some((d) => d.id === row.rid))
    return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const sp = request.nextUrl.searchParams;
  const dayOffsetMin = row.dayOffsetMin;

  // `last=Nd` resolves HERE rather than in the caller, for the same reason `/api/history` resolves
  // its own: the window is whole LOCAL days at the device's fixed offset, and a client that
  // computed it would have to fetch the offset first and would get it wrong the day it changed.
  // WHOLE DAYS ONLY — coverage has no sub-daily meaning, so `3h` is a usage error rather than
  // something silently rounded.
  const last = sp.get("last");
  let start = sp.get("start");
  let end = sp.get("end");
  if (last !== null) {
    if (start || end)
      return NextResponse.json(
        { error: "pass last, or start+end — not both" },
        { status: 400 },
      );
    const m = /^(\d+)d$/.exec(last);
    if (!m)
      return NextResponse.json(
        {
          error: `last must be a whole number of days, e.g. 30d (got "${last}")`,
        },
        { status: 400 },
      );
    const n = Number(m[1]);
    if (n < 1 || n > 3660)
      return NextResponse.json(
        { error: "last must be between 1d and 3660d" },
        { status: 400 },
      );
    const localNowMs = Date.now() + dayOffsetMin * 60_000;
    const today = new Date(localNowMs).toISOString().slice(0, 10);
    end = today;
    start = new Date(localNowMs - (n - 1) * DAY_MS).toISOString().slice(0, 10);
  }
  if (!start || !validDay(start) || !end || !validDay(end))
    return NextResponse.json(
      {
        error:
          "start and end are required, as real YYYY-MM-DD local days (or last=Nd)",
      },
      { status: 400 },
    );
  if (start > end)
    return NextResponse.json(
      { error: `start (${start}) is after end (${end})` },
      { status: 400 },
    );
  // The span cap applies to BOTH window forms. `last=Nd` bounded itself; an explicit start/end was
  // unbounded, which is the same unbounded scan by another spelling.
  const spanDays =
    Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
  if (spanDays > MAX_SPAN_DAYS)
    return NextResponse.json(
      { error: `window is ${spanDays} days; the maximum is ${MAX_SPAN_DAYS}` },
      { status: 400 },
    );

  const seriesParam = sp.get("series");
  const patterns = seriesParam ? splitBraceAware(seriesParam) : undefined;
  if (patterns?.some((p) => p.length > 200))
    return NextResponse.json(
      { error: "a series pattern is too long (max 200 characters)" },
      { status: 400 },
    );

  const cadenceRaw = sp.get("cadence");
  let cadence: number | null = null;
  if (cadenceRaw !== null) {
    cadence = Number(cadenceRaw);
    if (!Number.isInteger(cadence) || cadence <= 0 || cadence > 1440)
      return NextResponse.json(
        { error: `cadence must be a whole number of minutes in 1..1440` },
        { status: 400 },
      );
  }

  // `samples=true` adds each day's mean raw readings per row — a second grouped scan, so opt-in.
  const samples = sp.get("samples") === "true";

  const report = await buildDeviceCoverage(
    {
      id: Device.encode(row.id),
      name: row.name,
      handle: row.rid,
      vendor: row.vendor,
      status: row.status,
      dayOffsetMin,
    },
    { start, end },
    patterns,
    cadence,
    samples,
  );
  return NextResponse.json(report, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
