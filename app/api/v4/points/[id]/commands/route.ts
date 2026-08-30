import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { getByIds } from "@/lib/automations/store";
import { loadPointByUuid } from "@/lib/control/point-actions";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { pointCommands, points } from "@/lib/db/planetscale/schema";
import { Automation, Point } from "@/lib/ids";

/**
 * The command AUDIT TRAIL, readable — "why did my car stop charging at 2am", answered over HTTP
 * instead of SQL.
 *
 *   GET /api/v4/points/{pt_…}/commands?limit=20&offset=0
 *     → 200 { commands: [...], hasMore, offset, limit }
 *
 * Offset paging rather than a cursor: the trail is append-only at the HEAD, so a page boundary can
 * only shift when a new command lands while the reader is paging — which shows them a row twice at
 * worst, in a read-only log they opened to skim. A cursor would buy nothing for that.
 *
 * Point-addressed like its `action`/`refresh` siblings (a point id names its device, so the
 * resolver and the owner-only gate are shared machinery), but the response is DEVICE-scoped:
 * every command on the point's device, newest first, so start/stop and the two setpoints all
 * appear in one timeline. Rides `point_commands`' `(device_id, requested_at)` index — the
 * "per-device command timeline" it was declared for.
 *
 * Wire shape (formatted into sentences by `lib/control/command-log.ts`):
 *  - `requestedBy` collapses any clerk `user_…` id to `{kind:"user"}` — clerk ids stay off the
 *    wire — and resolves `automation:au_…` to `{kind:"automation", automationId, name}`, with
 *    `name: null` when the rule has since been deleted;
 *  - `reason` is the vendor's benign-decline token out of `vendor_result` (e.g. `not_charging`),
 *    null otherwise;
 *  - row uuids are NOT exposed: the list is read-only, so there is nothing to address.
 *
 * Owner-only (`requireOwner` alone, the control-plane rule): the trail records who commanded a
 * device, which is the owner's business exactly as issuing commands is. Deliberately absent from
 * `publicRoutes`/`shareableRoutes` like its siblings.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = Point.parse(id);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `Invalid point id: ${parsed.message}` },
        { status: 400 },
      );
    }

    const resolved = await loadPointByUuid(Point.toUuid(parsed.id));
    if (!resolved) {
      return NextResponse.json({ error: "Point not found" }, { status: 404 });
    }

    const auth = await requireDeviceAccess(request, resolved.deviceRid, {
      requireOwner: true,
    });
    if (auth instanceof NextResponse) return auth;

    const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50)
      : 20;
    const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
    const offset =
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

    // Fetch one MORE than asked for: `hasMore` then costs nothing, where a COUNT(*) over a table
    // that only grows would cost a second query to answer a question the caller only needs
    // yes/no to. The extra row is dropped before it reaches the wire.
    const rows = await requirePlanetscaleDb()
      .select({ command: pointCommands, point: points })
      .from(pointCommands)
      .innerJoin(points, eq(points.id, pointCommands.pointId))
      .where(eq(pointCommands.deviceId, resolved.point.deviceId))
      .orderBy(desc(pointCommands.requestedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    // Resolve automation names in one batch; a deleted rule is simply absent → name: null.
    const automationUuids = [
      ...new Set(
        rows
          .map(({ command }) =>
            command.requestedBy.startsWith("automation:")
              ? Automation.toUuidOrNull(
                  command.requestedBy.slice("automation:".length),
                )
              : null,
          )
          .filter((u): u is string => u !== null),
      ),
    ];
    const names = new Map(
      (await getByIds(automationUuids)).map((a) => [a.id, a.name]),
    );

    const commands = rows.map(({ command, point }) => {
      const auUuid = command.requestedBy.startsWith("automation:")
        ? Automation.toUuidOrNull(
            command.requestedBy.slice("automation:".length),
          )
        : null;
      const vendorReason = (command.vendorResult as { reason?: unknown } | null)
        ?.reason;
      return {
        pointId: Point.encode(command.pointId),
        logicalPath: point.logicalPath,
        metricType: point.metricType,
        action: command.action,
        value: command.value,
        status: command.status,
        reason:
          typeof vendorReason === "string" && vendorReason
            ? vendorReason
            : null,
        error: command.error,
        requestedBy: auUuid
          ? {
              kind: "automation" as const,
              automationId: Automation.encode(auUuid),
              name: names.get(auUuid) ?? null,
            }
          : { kind: "user" as const },
        requestedAt: command.requestedAt,
        completedAt: command.completedAt,
      };
    });

    return NextResponse.json({ commands, hasMore, offset, limit });
  } catch (error) {
    console.error("[control] point commands route failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load commands",
      },
      { status: 500 },
    );
  }
}
