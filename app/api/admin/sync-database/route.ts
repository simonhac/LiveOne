// Development-only route for database syncing
// In production builds, route.production.ts will be used instead

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { clerkIdMapping } from "@/lib/db/schema";
import { syncStages, type SyncContext, type StageDefinition } from "./stages";

// Helper to create a streaming response
function createStreamResponse() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });

  const send = (data: any) => {
    const line = JSON.stringify(data) + "\n";
    controller.enqueue(encoder.encode(line));
  };

  const close = () => {
    controller.close();
  };

  return { stream, send, close };
}

// Stage status type
interface SyncStage {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  detail?: string;
  progress?: number; // 0-1 for proportion complete within the stage
  startTime?: number;
  duration?: number;
}

export async function POST(request: NextRequest) {
  // CRITICAL: This endpoint must NEVER run in production
  // Multiple checks to ensure safety:
  // 1. Check if we're on the production domain
  // 2. Check if we're using the production database
  // 3. Check Vercel environment

  const host = request.headers.get("host");
  const isProductionDomain =
    host?.includes("liveone.energy") || host?.includes("liveone.vercel.app");
  const isProductionDatabase =
    process.env.TURSO_DATABASE_URL?.includes("liveone-tokyo");
  const isVercelProduction = process.env.VERCEL_ENV === "production";

  if (isProductionDomain || (isProductionDatabase && isVercelProduction)) {
    console.error(
      `CRITICAL: Attempt to run sync-database in production! Host: ${host}, Vercel Env: ${process.env.VERCEL_ENV}`,
    );
    return NextResponse.json(
      {
        error: "Not found",
      },
      { status: 404 },
    );
  }

  try {
    // Check if user is authenticated and admin
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const isAdmin = await isUserAdmin();

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;

    if (!tursoUrl || !tursoToken) {
      return NextResponse.json(
        {
          error: "Production database credentials not configured",
        },
        { status: 400 },
      );
    }

    // Read parameters from request body
    const body = await request.json().catch(() => ({}));
    const syncMetadata = body.syncMetadata === true;
    const previewOnly = body.previewOnly === true;

    // Filter stages based on syncMetadata flag
    let stagesToRun = syncMetadata
      ? syncStages
      : syncStages.filter((stage) => !stage.modifiesMetadata);

    // If preview mode, only run prepare and count stages
    if (previewOnly) {
      stagesToRun = stagesToRun.filter(
        (stage) =>
          stage.id === "prepare" || stage.id === "count-records-to-sync",
      );
    }

    console.log(
      `[SYNC] Starting ${previewOnly ? "preview" : "sync"} with ${stagesToRun.length} stages (syncMetadata: ${syncMetadata})`,
    );

    // Create streaming response
    const { stream, send, close } = createStreamResponse();

    // Start the sync process in the background
    syncDatabase(send, close, request.signal, stagesToRun).catch((err) => {
      console.error("Sync error:", err);
      send({ type: "error", message: err.message });
      close();
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (error) {
    console.error("Sync initialisation error:", error);
    return NextResponse.json(
      {
        error: "Failed to start sync",
      },
      { status: 500 },
    );
  }
}

async function syncDatabase(
  send: (data: any) => void,
  close: () => void,
  signal: AbortSignal,
  stagesToRun: StageDefinition[],
) {
  // Initialise all stages upfront
  const stages: SyncStage[] = stagesToRun.map((def) => ({
    id: def.id,
    name: def.name,
    status: "pending" as const,
  }));

  // Helper to update and send stage status
  const updateStage = (id: string, updates: Partial<SyncStage>) => {
    const stage = stages.find((s) => s.id === id);
    if (stage) {
      Object.assign(stage, updates);
      if (updates.status === "running" && !stage.startTime) {
        stage.startTime = Date.now();
        console.log(
          `[SYNC] Stage '${stage.name}' started at ${new Date(stage.startTime).toISOString()}`,
        );
      }
      if (updates.status === "completed" && stage.startTime) {
        const endTime = Date.now();
        stage.duration = (endTime - stage.startTime) / 1000;
        console.log(
          `[SYNC] Stage '${stage.name}' completed in ${stage.duration.toFixed(3)}s (${stage.duration < 1 ? `${Math.round(stage.duration * 1000)}ms` : `${stage.duration.toFixed(1)}s`})`,
        );
      }
      if (updates.status === "error") {
        console.log(
          `[SYNC] Stage '${stage.name}' failed: ${updates.detail || "Unknown error"}`,
        );
      }

      // Send the updated stage
      send({
        type: "stage-update",
        stage: {
          id: stage.id,
          name: stage.name,
          status: stage.status,
          detail: stage.detail,
          progress: stage.progress,
          startTime: stage.startTime,
          duration: stage.duration,
        },
      });

      // Update overall progress bar - stages calculate their own progress based on records
      if (updates.progress !== undefined) {
        send({
          type: "progress",
          message:
            stage.detail ||
            `${stage.name}: ${Math.round(updates.progress * 100)}%`,
          progress: Math.round(updates.progress * 100),
          total: 100,
        });
      }
    }
  };

  // Format datetime helper
  const formatDateTime = (date: Date) => {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    const displayHours = hours % 12 || 12;
    return `${day} ${month} ${year} ${displayHours}:${minutes}${ampm}`;
  };

  // Build initial context
  let context: SyncContext = {
    db,
    prodDb: null as any,
    signal,
    updateStage,
    send,
    clerkMappings: new Map(),
    mapClerkId: () => undefined,
    systemIdMappings: new Map(),
    mapSystemId: () => undefined,
    cumulativeSynced: 0,
    formatDateTime,
  };

  try {
    // Send initial stages (all at once for initialization)
    send({ type: "stages-init", stages: [...stages] });

    // Load Clerk ID mappings upfront (needed for context)
    try {
      const mappings = await db.select().from(clerkIdMapping);
      console.log(`[SYNC] Found ${mappings.length} Clerk ID mappings`);
      for (const mapping of mappings) {
        context.clerkMappings.set(mapping.prodClerkId, mapping.devClerkId);
        console.log(
          `[SYNC] Loaded mapping: ${mapping.username} - prod:${mapping.prodClerkId.slice(0, 15)}... -> dev:${mapping.devClerkId.slice(0, 15)}...`,
        );
      }
      context.mapClerkId = (
        prodId: string | null | undefined,
      ): string | undefined => {
        if (!prodId) return undefined;
        const mappedId = context.clerkMappings.get(prodId);
        if (!mappedId) {
          console.warn(
            `Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`,
          );
          return undefined; // CRITICAL: Never copy production IDs to dev
        }
        return mappedId;
      };
    } catch (err: any) {
      console.error("[SYNC] Error loading Clerk ID mappings:", err.message);
      context.mapClerkId = (
        prodId: string | null | undefined,
      ): string | undefined => {
        console.warn(
          `Warning: No dev Clerk ID mapping for production ID: ${prodId} - skipping`,
        );
        return undefined;
      };
    }

    // Execute stages in sequence
    for (const stageDef of stagesToRun) {
      if (signal.aborted) throw new Error("Sync cancelled");

      // Update stage to running (don't set progress - let the stage's onProgress callback handle it)
      updateStage(stageDef.id, { status: "running" });

      try {
        // Execute the stage
        const result = await stageDef.execute(context);

        // Update context with any changes from the stage
        if (result.context) {
          Object.assign(context, result.context);
        }

        // Increment cumulative synced count after stage completes
        if (context.recordCounts && context.recordCounts[stageDef.id]) {
          context.cumulativeSynced =
            (context.cumulativeSynced || 0) + context.recordCounts[stageDef.id];
        }

        // Mark stage as completed (don't set progress - let it stay at whatever the last progress update was)
        updateStage(stageDef.id, {
          status: "completed",
          detail: result.detail,
        });

        // Send record counts to frontend when count stage completes
        if (stageDef.id === "count-records-to-sync" && context.recordCounts) {
          send({
            type: "record-counts",
            counts: context.recordCounts,
          });
        }

        // Special handling for early exit (no data to sync)
        if (
          stageDef.id === "count-records-to-sync" &&
          context.totalToSync === 0
        ) {
          // Mark remaining stages as completed/skipped
          const remainingStages = stagesToRun.slice(
            stagesToRun.indexOf(stageDef) + 1,
          );
          for (const remaining of remainingStages) {
            if (remaining.id === "finalise") {
              updateStage(remaining.id, {
                status: "completed",
                detail: "Complete",
                progress: 1,
              });
            } else {
              updateStage(remaining.id, {
                status: "completed",
                detail: "Skipped - no new data",
                progress: 1,
              });
            }
          }

          send({
            type: "progress",
            message: "Local database is already up to date!",
            progress: 100,
            total: 100,
          });
          send({ type: "complete" });
          close();
          return;
        }
      } catch (error: any) {
        // Mark stage as failed
        updateStage(stageDef.id, {
          status: "error",
          detail: error.message,
        });

        // Stop processing
        throw error;
      }
    }

    // All stages completed successfully
    send({
      type: "progress",
      message: `Successfully synced ${context.synced?.toLocaleString() || 0} readings from production!`,
      progress: 100,
      total: 100,
    });
    send({ type: "complete" });
    close();
  } catch (error: any) {
    if (error.message === "Sync cancelled") {
      send({ type: "error", message: "Sync was cancelled by user" });
    } else {
      console.error("Sync error:", error);
      send({ type: "error", message: error.message || "Sync failed" });
    }
    close();
  }
}
