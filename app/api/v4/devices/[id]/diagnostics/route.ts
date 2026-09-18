/**
 * `GET|POST /api/v4/devices/{id}/diagnostics` — the retained diagnostic captures for one device,
 * and the manual way to ask for another.
 *
 * 🛑 POST does NOT open a connection to the inverter. It enqueues a `diagnostic_jobs` row and the
 * minutely worker (`/api/cron/diagnostics`) picks it up. That is the whole point of the job table:
 * one acquisition per device at a time, whether the request came from a fault transition or from an
 * operator, coalesced rather than raced. An HTTP request that dialled the inverter itself would sit
 * on a serverless function's clock for 40 seconds and would have no way to coordinate with the
 * automatic path.
 *
 * Reachable by the CLI because `/api/v4/devices(.*)` is already in `cliTokenRoutes` — which is only
 * honest because every handler here calls `requireDeviceAccess`. Do not remove that call.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDeviceAccess } from "@/lib/api-auth";
import { Device } from "@/lib/ids";
import { resolveDeviceParam } from "@/lib/diagnostics/resolve-device";
import {
  enqueueDiagnosticJob,
  listCaptures,
  openJobFor,
} from "@/lib/diagnostics/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDeviceParam(params);
  if ("error" in resolved) return resolved.error;
  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const [captures, openJob] = await Promise.all([
    listCaptures(resolved.systemId, Number.isFinite(limit) ? limit : 50),
    openJobFor(resolved.systemId),
  ]);
  return NextResponse.json({
    ok: true,
    deviceId: Device.encode(resolved.uuid),
    systemId: resolved.systemId,
    // Surfaced alongside the captures on purpose: "nothing has been captured yet" and "a capture
    // has been pending for six hours because the inverter is unreachable" look identical otherwise.
    openJob: openJob
      ? {
          id: openJob.id,
          status: openJob.status,
          attempts: openJob.attempts,
          requestedBy: openJob.requestedBy,
          nextAttemptAt: openJob.nextAttemptAt,
          lastError: openJob.lastError,
          createdAt: openJob.createdAt,
          reasons: openJob.reasons,
        }
      : null,
    captures,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolveDeviceParam(params);
  if ("error" in resolved) return resolved.error;
  const auth = await requireDeviceAccess(request, resolved.systemId);
  if (auth instanceof NextResponse) return auth;
  if (!auth.canWrite)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const note =
    typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : "requested from the CLI";
  const { jobId, coalesced } = await enqueueDiagnosticJob(
    resolved.systemId,
    [
      {
        kind: "manual",
        detail: note,
        observedAt: new Date().toISOString(),
      },
    ],
    "cli",
  );
  return NextResponse.json({
    ok: true,
    jobId,
    // True when an acquisition was ALREADY open for this device and this request joined it rather
    // than starting a second one.
    coalesced,
    deviceId: Device.encode(resolved.uuid),
  });
}
