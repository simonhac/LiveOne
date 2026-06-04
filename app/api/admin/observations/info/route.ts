/**
 * Admin API for Observations Queue Info
 *
 * GET /api/admin/observations/info
 * Returns queue status (paused, lag, parallelism)
 *
 * POST /api/admin/observations/info
 * Actions: pause, resume
 */

import { NextResponse } from "next/server";
import { qstash, OBSERVATIONS_QUEUE_NAME } from "@/lib/qstash";

interface QueueInfo {
  name: string;
  paused: boolean;
  lag: number;
  parallelism: number;
}

export async function GET() {
  if (!qstash) {
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );
  }

  try {
    const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
    let queueInfo: QueueInfo;

    try {
      const info = await queue.get();
      queueInfo = {
        name: OBSERVATIONS_QUEUE_NAME,
        paused: info.paused ?? false,
        lag: info.lag ?? 0,
        parallelism: info.parallelism ?? 1,
      };
    } catch (error: any) {
      // Queue might not exist yet
      if (error?.message?.includes("not found") || error?.status === 404) {
        queueInfo = {
          name: OBSERVATIONS_QUEUE_NAME,
          paused: true,
          lag: 0,
          parallelism: 1,
        };
      } else {
        throw error;
      }
    }

    return NextResponse.json(queueInfo);
  } catch (error) {
    console.error("[AdminObservations] GET info error:", error);
    return NextResponse.json(
      { error: "Failed to get queue info" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!qstash) {
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );
  }

  try {
    const body = await request.json();
    const { action } = body;

    const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });

    switch (action) {
      case "pause":
        await queue.upsert({ paused: true });
        return NextResponse.json({ status: "paused" });

      case "resume":
        await queue.upsert({ paused: false });
        return NextResponse.json({ status: "resumed" });

      case "set-parallelism": {
        const n = Number(body.parallelism);
        if (!Number.isInteger(n) || n < 1 || n > 20) {
          return NextResponse.json(
            { error: "parallelism must be an integer between 1 and 20" },
            { status: 400 },
          );
        }
        // Keep ≤ the Postgres pool size (max 10) to avoid exhausting connections
        // while draining a large backlog.
        await queue.upsert({ parallelism: n });
        return NextResponse.json({ status: "ok", parallelism: n });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("[AdminObservations] POST info error:", error);
    return NextResponse.json(
      { error: "Failed to perform action" },
      { status: 500 },
    );
  }
}
