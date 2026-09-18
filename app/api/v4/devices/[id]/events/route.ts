/**
 * `GET /api/v4/devices/{id}/events` — the retained fault history: portal events, inverter events,
 * or both.
 *
 * 🛑 The two sources are returned side by side and LABELLED, never merged. Their codes overlap and
 * their clocks do not agree (on 18 September 2026 the portal displayed a low-DC clearance at
 * 12:12:59 while the inverter recorded 12:02:12 on its own clock, ~46 s slow). Collapsing them
 * would manufacture a single timeline that neither source supports.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { Device } from "@/lib/ids";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import { listDeviceEvents } from "@/lib/diagnostics/store";

const parseDate = (value: string | null): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDeviceParam(params);
  if ("error" in resolved) return resolved.error;
  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;

  const search = request.nextUrl.searchParams;
  const source = search.get("source") as "portal" | "inverter" | null;
  if (source && source !== "portal" && source !== "inverter")
    return NextResponse.json(
      { error: "source must be portal or inverter" },
      { status: 400 },
    );
  const limitParam = search.get("limit");
  const limit = limitParam === null ? undefined : Number(limitParam);
  const events = await listDeviceEvents({
    deviceRid: resolved.systemId,
    source: source ?? undefined,
    since: parseDate(search.get("since")),
    until: parseDate(search.get("until")),
    captureId: search.get("capture") ?? undefined,
    limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
  });
  return NextResponse.json({
    ok: true,
    deviceId: Device.encode(resolved.uuid),
    systemId: resolved.systemId,
    events,
  });
}
