import { NextRequest, NextResponse } from "next/server";
import { SystemsManager } from "@/lib/systems-manager";
import {
  updatePollingStatusSuccess,
  updatePollingStatusError,
} from "@/lib/polling-utils";
import { sessionManager } from "@/lib/session-manager";
import { PointManager, type SessionInfo } from "@/lib/point/point-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { getSystemCredentials } from "@/lib/secure-credentials";
import type { PointReadingInput } from "@/lib/vendors/types";
import type { GushRequestBody } from "@/lib/push/types";

/**
 * gusher — the generic push receiver.
 *
 * Any pusher (musher/fusher/…) POSTs self-describing point readings here; each reading carries its
 * own `point_info` metadata, so this route needs no per-vendor knowledge. Auth is siteId + apiKey
 * (validated against the system owner's stored credential), mirroring the fusher push model. Readings
 * flow through the same pipeline as polls: `insertPointReadingsRaw` → collector → outbox/QStash →
 * `/api/observations/receive` (single writer) → `point_readings` (+ PG 5m recompute). Idempotent on
 * `(systemId, pointId, measurementTime)`.
 */

async function recordFailedSession(
  sessionStart: Date,
  systemId: number,
  errorCode: string | null,
  error: string,
  requestData: unknown,
) {
  await sessionManager.recordSession({
    systemId,
    cause: "PUSH",
    started: sessionStart,
    duration: Date.now() - sessionStart.getTime(),
    successful: false,
    errorCode,
    error,
    response: requestData,
    numRows: 0,
  });
}

export async function POST(request: NextRequest) {
  const sessionStart = new Date();

  try {
    const data: GushRequestBody = await request.json();

    if (!data.apiKey) {
      return NextResponse.json({ error: "Missing apiKey" }, { status: 400 });
    }
    if (!data.vendorSiteId) {
      return NextResponse.json(
        { error: "Missing vendorSiteId" },
        { status: 400 },
      );
    }
    if (!data.action || (data.action !== "test" && data.action !== "store")) {
      return NextResponse.json(
        { error: 'Missing or invalid action. Must be "test" or "store"' },
        { status: 400 },
      );
    }

    let batchTimeMs = NaN;
    if (data.action === "store") {
      if (!data.sessionLabel) {
        return NextResponse.json(
          { error: "Missing sessionLabel (required for store action)" },
          { status: 400 },
        );
      }
      // A batch measurementTime is the default for readings that don't set their own.
      batchTimeMs = data.measurementTime
        ? Date.parse(data.measurementTime)
        : NaN;
      const anyPerReadingTime = (data.readings ?? []).every(
        (r) => r.measurementTime,
      );
      if (Number.isNaN(batchTimeMs) && !anyPerReadingTime) {
        return NextResponse.json(
          {
            error:
              "Missing/invalid measurementTime (required for store unless every reading sets its own)",
          },
          { status: 400 },
        );
      }
      if (!data.readings?.length) {
        return NextResponse.json(
          { error: "Missing readings (required for store action)" },
          { status: 400 },
        );
      }
    }

    const systemsManager = SystemsManager.getInstance();
    const system = await systemsManager.getSystemByVendorSiteId(
      data.vendorSiteId,
    );
    if (!system) {
      console.error(
        `[gush] System not found for vendorSiteId: ${data.vendorSiteId}`,
      );
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    if (!system.ownerClerkUserId) {
      return NextResponse.json(
        { error: "System has no owner configured" },
        { status: 500 },
      );
    }

    const credentials = await getSystemCredentials(
      system.ownerClerkUserId,
      system.id,
    );
    // The apiKey check implicitly gates to push systems: poll vendors store login creds, not an apiKey.
    if (!credentials || credentials.apiKey !== data.apiKey) {
      await recordFailedSession(
        sessionStart,
        system.id,
        "401",
        credentials ? "Invalid API key" : "No credentials configured",
        { action: data.action, vendorSiteId: data.vendorSiteId },
      );
      return NextResponse.json(
        {
          error: credentials ? "Invalid API key" : "No credentials configured",
        },
        { status: 401 },
      );
    }

    // action=test — validate auth without storing
    if (data.action === "test") {
      await sessionManager.recordSession({
        systemId: system.id,
        cause: "PUSH",
        started: sessionStart,
        duration: Date.now() - sessionStart.getTime(),
        successful: true,
        response: { action: "test", vendorSiteId: data.vendorSiteId },
        numRows: 0,
      });
      return NextResponse.json({
        success: true,
        action: "test",
        message: "Authentication successful",
        systemId: system.id,
        displayName: system.displayName,
      });
    }

    // action=store — map self-describing readings onto PointReadingInput[]
    const readingsToInsert: PointReadingInput[] = [];
    for (const r of data.readings ?? []) {
      if (r == null || r.value == null || !r.physicalPathTail) continue;
      if (!r.metricType || !r.metricUnit) continue; // metadata required to create the point
      const t = r.measurementTime ? Date.parse(r.measurementTime) : batchTimeMs;
      if (Number.isNaN(t)) continue;
      readingsToInsert.push({
        pointMetadata: {
          physicalPathTail: r.physicalPathTail,
          logicalPathStem: r.logicalPathStem ?? null,
          defaultName: r.defaultName ?? r.physicalPathTail,
          subsystem: r.subsystem ?? null,
          metricType: r.metricType,
          metricUnit: r.metricUnit,
          transform: r.transform ?? null,
        },
        rawValue: r.value,
        measurementTime: t,
        dataQuality: "good",
        error: null,
      });
    }

    console.log(
      `[gush] system ${system.id} (${system.displayName}) seq=${data.sessionLabel} ` +
        `readings=${data.readings?.length ?? 0} stored=${readingsToInsert.length}`,
    );

    let session: SessionInfo;
    try {
      session = await sessionManager.createSession({
        sessionLabel: data.sessionLabel,
        systemId: system.id,
        cause: "PUSH",
        started: sessionStart,
      });
    } catch (sessionError) {
      console.error("[gush] Failed to create session:", sessionError);
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 500 },
      );
    }

    const collector = createPollCollector();

    try {
      if (readingsToInsert.length > 0) {
        await PointManager.getInstance().insertPointReadingsRaw(
          system.id,
          session,
          readingsToInsert,
          collector,
        );
      }

      await updatePollingStatusSuccess(system.id, {
        sessionLabel: data.sessionLabel,
        readings: readingsToInsert.length,
      });

      await sessionManager.updateSessionResult(
        session.id,
        {
          duration: Date.now() - sessionStart.getTime(),
          successful: true,
          response: {
            sessionLabel: data.sessionLabel,
            readings: readingsToInsert.length,
          },
          numRows: readingsToInsert.length,
        },
        collector.observations,
      );

      return NextResponse.json({
        success: true,
        action: "store",
        message: "Readings received and stored",
        systemId: system.id,
        pointsStored: readingsToInsert.length,
      });
    } catch (dbError) {
      console.error(`[gush] DB error for system ${system.id}:`, dbError);
      await updatePollingStatusError(
        system.id,
        dbError instanceof Error ? dbError : "Database error",
      );
      const errorMessage =
        dbError instanceof Error ? dbError.message : String(dbError);
      await sessionManager.updateSessionResult(
        session.id,
        {
          duration: Date.now() - sessionStart.getTime(),
          successful: false,
          errorCode: null,
          error: errorMessage,
          response: { sessionLabel: data.sessionLabel },
          numRows: 0,
        },
        collector.observations,
      );
      throw dbError;
    }
  } catch (error) {
    console.error("[gush] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

// Health check / contract discovery
export async function GET() {
  return NextResponse.json({
    status: "ready",
    endpoint: "/api/gush",
    method: "POST",
    note: "Generic self-describing push receiver. Auth = vendorSiteId + apiKey (validated vs the system owner's stored credential).",
    body: {
      always: ["vendorSiteId", "apiKey", "action"],
      forStoreAction: ["sessionLabel", "measurementTime", "readings"],
      reading: {
        required: ["physicalPathTail", "value", "metricType", "metricUnit"],
        optional: [
          "logicalPathStem",
          "defaultName",
          "subsystem",
          "transform",
          "measurementTime",
        ],
      },
    },
  });
}
