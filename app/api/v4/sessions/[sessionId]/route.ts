import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as devicesTable,
  sessions as sessionsTable,
} from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";

/**
 * `GET /api/v4/sessions/{sessionId}` — one session, with its manifest. For `liveone session show`.
 *
 * Addressed by session id alone, not under its device, because that is how a reader arrives: from a
 * row's `session_id`, asking "where did this number come from?". Requiring them to already know the
 * device would make the answer reachable only by those who did not need to ask.
 *
 * Authorisation still runs against the session's DEVICE — the session is not a separate thing to be
 * granted, it is a fact about that device's data. An id for a device the caller cannot read is a
 * 404, not a 403, so this cannot be used to probe which session ids exist.
 */

export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const db = requirePlanetscaleDb();

  const [row] = await db
    .select({
      id: sessionsTable.id,
      label: sessionsTable.sessionLabel,
      deviceRid: sessionsTable.deviceRid,
      deviceUuid: devicesTable.id,
      deviceName: devicesTable.name,
      cause: sessionsTable.cause,
      duration: sessionsTable.duration,
      successful: sessionsTable.successful,
      errorCode: sessionsTable.errorCode,
      error: sessionsTable.error,
      numRows: sessionsTable.numRows,
      manifest: sessionsTable.response,
      createdAt: sessionsTable.createdAt,
    })
    .from(sessionsTable)
    .innerJoin(devicesTable, eq(devicesTable.rid, sessionsTable.deviceRid))
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const auth = await requireDeviceAccess(request, row.deviceRid);
  if (auth instanceof NextResponse)
    // Collapse "cannot read that device" into the same 404 as "no such session", so the endpoint is
    // not an existence oracle over other owners' sessions.
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    session: {
      id: row.id,
      label: row.label,
      device: {
        id: Device.encode(row.deviceUuid),
        systemId: row.deviceRid,
        name: row.deviceName,
      },
      cause: row.cause,
      duration: row.duration,
      successful: row.successful,
      errorCode: row.errorCode,
      error: row.error,
      numRows: row.numRows,
      createdAt: row.createdAt.toISOString(),
      // `sessions.response` under its operator-facing name. For a poll this is the vendor's raw
      // payload; for an import it is the manifest that says where the rows came from.
      manifest: row.manifest,
    },
  });
}
