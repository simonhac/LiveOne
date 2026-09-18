/**
 * `GET /api/v4/devices/{id}/diagnostics/{captureId}` — one capture in full, including its raw
 * record stream.
 *
 * The raw bytes are served because they are the point: a capture is evidence, and an export that
 * carried only our decoding of it would be unverifiable and unre-decodable. Sizes are small (a full
 * first capture of both logs is ~1000 records × 72 bytes of hex).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import { getCapture } from "@/lib/diagnostics/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; captureId: string }> },
) {
  const resolvedParams = await params;
  const resolved = await resolveDeviceParam(
    Promise.resolve({ id: resolvedParams.id }),
  );
  if ("error" in resolved) return resolved.error;
  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;

  const capture = await getCapture(resolved.systemId, resolvedParams.captureId);
  if (!capture)
    return NextResponse.json({ error: "Capture not found" }, { status: 404 });
  return NextResponse.json({ ok: true, capture });
}
