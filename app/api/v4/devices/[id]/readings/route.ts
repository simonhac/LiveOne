/**
 * `GET /api/v4/devices/{id}/readings` — a device's RAW `point_readings`, untransformed and with every
 * timestamp at microsecond precision. The operator read behind `liveone device readings`.
 *
 * It exists so incident evidence can be acquired as the operator, with a `lo_cli_` token, instead of
 * by minting a prod database role and running a one-off script (the September 2026 Daylesford
 * outage acquisition was exactly that). It returns what that script pulled: every point of the
 * device INCLUDING inactive ones, `value`/`value_str`/`error`/`data_quality`, `session_id`, and
 * `measurement_time`/`received_time`/`created_at` as µs-exact UTC text.
 *
 * Query:
 *   since, until   REQUIRED ISO instants; `measurement_time >= since AND < until`; at most 7 days.
 *   point          repeatable `pt_…` — only these points (each must belong to the device).
 *   series         repeatable glob over the point's logical path (`{stem}/{metricType}`, e.g.
 *                  `load/*`) or its physical-path tail; `*` does not cross `/`.
 *   limit          rows per page, default 5000, max 10000.
 *   asOf, cursor   paging. The first page mints `asOf` (the DATABASE's now()) and returns it; echo
 *                  it, with `nextCursor`, on every later page so the pages are one snapshot.
 *
 * Values are `raw-untransformed`: `points.transform` ('i' = stored inverted) is reported in the
 * points block but NOT applied, because evidence whose sign depends on today's transform column is
 * not a record of what was stored.
 *
 * Read-level device access (`requireDeviceAccess`), like every other device read.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import micromatch from "micromatch";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { points as pointsTable } from "@/lib/db/planetscale/schema";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import { Device, Point, type PointId } from "@/lib/ids";
import { InvalidRawExportCursor, ReadingsDao } from "@/lib/readings/dao";

export const maxDuration = 60;

const MAX_SPAN_MS = 7 * 86_400_000;
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 10_000;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** An ISO instant with an explicit zone (`Z` or `±hh:mm`) — a zone-less string is a guess. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function instant(name: string, raw: string | null): number | string {
  if (!raw)
    return `${name} is required (an ISO instant, e.g. 2026-09-17T09:21:00Z)`;
  const ms = Date.parse(raw);
  if (!ISO_INSTANT.test(raw) || !Number.isFinite(ms))
    return `${name} must be an ISO instant with a zone, e.g. 2026-09-17T09:21:00Z`;
  return ms;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDeviceParam(params);
  if ("error" in resolved) return resolved.error;
  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;

  const sp = request.nextUrl.searchParams;
  const sinceMs = instant("since", sp.get("since"));
  if (typeof sinceMs === "string") return bad(sinceMs);
  const untilMs = instant("until", sp.get("until"));
  if (typeof untilMs === "string") return bad(untilMs);
  if (untilMs <= sinceMs) return bad("until must be after since");
  if (untilMs - sinceMs > MAX_SPAN_MS)
    return bad("the window is at most 7 days; page a longer span by window");

  const rawLimit = sp.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    return bad(`limit must be an integer in [1, ${MAX_LIMIT}]`);

  const pointRefs = sp.getAll("point").flatMap((p) => p.split(","));
  for (const p of pointRefs)
    if (!Point.is(p)) return bad(`point ${p} is not a point id (pt_…)`);
  const globs = sp.getAll("series").flatMap((g) => g.split(","));

  const rows = await requirePlanetscaleDb()
    .select()
    .from(pointsTable)
    .where(eq(pointsTable.deviceId, resolved.uuid))
    .orderBy(asc(pointsTable.rid));
  const vendor = auth.device.vendorType;
  const site = auth.device.vendorSiteId;
  const allPoints = rows.map((p) => ({
    pointId: Point.encode(p.id),
    // Composed exactly as `GET /api/v4/devices/{id}?include=points` composes them, so the two
    // payloads name one point with one string.
    physicalPath: `liveone/${vendor}/${site}/${p.physicalPath}`,
    logicalPath: p.logicalPath ? `${p.logicalPath}/${p.metricType}` : null,
    metricType: p.metricType,
    unit: p.unit,
    name: p.name,
    transform: p.transform ?? null,
    active: p.active,
  }));
  const tailOf = new Map(rows.map((p) => [Point.encode(p.id), p.physicalPath]));

  const foreign = pointRefs.filter(
    (p) => !allPoints.some((x) => x.pointId === p),
  );
  if (foreign.length)
    return bad(`point ${foreign.join(", ")} is not on this device`);

  const matchesGlob = (p: (typeof allPoints)[number]) =>
    globs.some(
      (g) =>
        (p.logicalPath !== null && micromatch.isMatch(p.logicalPath, g)) ||
        micromatch.isMatch(tailOf.get(p.pointId) ?? "", g),
    );
  const filtered =
    pointRefs.length || globs.length
      ? allPoints.filter(
          (p) =>
            pointRefs.includes(p.pointId) ||
            (globs.length > 0 && matchesGlob(p)),
        )
      : allPoints;
  // A glob that matches nothing is a usage error, not an empty export — the same rule `device
  // history` applies, because "no readings" and "wrong pattern" must not look alike.
  if (globs.length && !allPoints.some(matchesGlob))
    return bad(`series ${globs.join(", ")} matched no point on this device`);

  let page;
  try {
    page = await ReadingsDao.readRawExportPage(Device.encode(resolved.uuid), {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      asOf: sp.get("asOf") ?? undefined,
      cursor: sp.get("cursor") ?? undefined,
      limit,
      ...(pointRefs.length || globs.length
        ? { pointIds: filtered.map((p) => p.pointId as PointId) }
        : {}),
    });
  } catch (e) {
    if (e instanceof InvalidRawExportCursor) return bad(e.message);
    throw e;
  }

  return NextResponse.json(
    {
      ok: true,
      deviceId: Device.encode(resolved.uuid),
      systemId: resolved.systemId,
      window: {
        since: new Date(sinceMs).toISOString(),
        until: new Date(untilMs).toISOString(),
      },
      asOf: page.asOf,
      values: "raw-untransformed",
      points: filtered,
      readings: page.readings,
      nextCursor: page.nextCursor,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
