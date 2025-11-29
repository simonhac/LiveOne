/**
 * Admin API for Observations Queue
 *
 * GET /api/admin/observations?limit=100
 * Returns queue status, pending messages, and DLQ info
 *
 * POST /api/admin/observations
 * Actions: pause, resume, retry-dlq
 */

import { NextRequest, NextResponse } from "next/server";
import { qstash, OBSERVATIONS_QUEUE_NAME } from "@/lib/qstash";
import { ObservationBatch } from "@/lib/observations/types";

// Default and max limit for messages
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

interface QueueInfo {
  name: string;
  paused: boolean;
  lag: number;
  parallelism: number;
}

interface PendingMessage {
  messageId: string;
  createdAt: number;
  retried: number;
  body: ObservationBatch | null;
}

interface DLQInfo {
  count: number;
  messages: Array<{
    messageId: string;
    topicName: string;
    url: string;
    body: string;
    createdAt: number;
    retried: number;
    maxRetries: number;
    responseStatus: number;
    responseBody: string;
  }>;
}

export async function GET(request: NextRequest) {
  if (!qstash) {
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );
  }

  // Parse limit from query params
  const searchParams = request.nextUrl.searchParams;
  const limitParam = searchParams.get("limit");
  const limit = Math.min(
    Math.max(
      1,
      parseInt(limitParam || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
    ),
    MAX_LIMIT,
  );

  try {
    // Get queue info
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

    // Get pending messages from the events API
    // Events API returns a log - we need to find messages that are CREATED but not yet terminated
    const pendingMessages: PendingMessage[] = [];
    try {
      const events = await qstash.events({});
      const allEvents = events.events ?? [];

      // Find messageIds that have been terminated (delivered, cancelled, or failed to DLQ)
      const terminatedMessageIds = new Set<string>();
      for (const e of allEvents) {
        if (
          e.queueName === OBSERVATIONS_QUEUE_NAME &&
          (e.state === "DELIVERED" ||
            e.state === "CANCELED" ||
            e.state === "ERROR")
        ) {
          terminatedMessageIds.add(e.messageId);
        }
      }

      // Get CREATED events that haven't been terminated
      const queueEvents = allEvents
        .filter(
          (e: any) =>
            e.queueName === OBSERVATIONS_QUEUE_NAME &&
            e.state === "CREATED" &&
            !terminatedMessageIds.has(e.messageId),
        )
        .slice(0, limit);

      for (const event of queueEvents) {
        let body: ObservationBatch | null = null;
        try {
          // Body is base64 encoded
          const decoded = Buffer.from(event.body || "", "base64").toString(
            "utf-8",
          );
          body = JSON.parse(decoded);
        } catch {
          // Ignore parse errors
        }
        pendingMessages.push({
          messageId: event.messageId,
          createdAt: event.time,
          retried: event.retried || 0,
          body,
        });
      }

      // Update lag to reflect actual pending count (since queue.lag is buggy)
      queueInfo.lag = pendingMessages.length;
    } catch (error) {
      console.error("[AdminObservations] Failed to get events:", error);
    }

    // Get DLQ messages
    let dlqInfo: DLQInfo = { count: 0, messages: [] };
    try {
      const dlqMessages = await qstash.dlq.listMessages({ count: limit });
      dlqInfo = {
        count: dlqMessages.messages?.length ?? 0,
        messages: (dlqMessages.messages ?? []).map((msg: any) => ({
          messageId: msg.messageId,
          topicName: msg.topicName || "",
          url: msg.url || "",
          body: msg.body || "",
          createdAt: msg.createdAt || 0,
          retried: msg.retried || 0,
          maxRetries: msg.maxRetry || 3,
          responseStatus: msg.responseStatus || 0,
          responseBody: msg.responseBody || "",
        })),
      };
    } catch (error) {
      console.error("[AdminObservations] Failed to get DLQ:", error);
    }

    return NextResponse.json({
      queue: queueInfo,
      pendingMessages,
      dlq: dlqInfo,
    });
  } catch (error) {
    console.error("[AdminObservations] GET error:", error);
    return NextResponse.json(
      { error: "Failed to get queue info" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
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

      case "retry-dlq":
        // Retry all DLQ messages
        // Note: This will retry ALL messages, not just observations queue messages
        // A more targeted approach would be to filter by URL
        const dlqMessages = await qstash.dlq.listMessages({ count: 1000 });
        let retried = 0;
        for (const msg of dlqMessages.messages ?? []) {
          try {
            await qstash.dlq.delete(msg.dlqId);
            // Re-enqueue the message
            await queue.enqueueJSON({
              url: msg.url,
              body: JSON.parse(msg.body || "{}"),
            });
            retried++;
          } catch (error) {
            console.error(
              `[AdminObservations] Failed to retry DLQ message ${msg.dlqId}:`,
              error,
            );
          }
        }
        return NextResponse.json({ status: "retried", count: retried });

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("[AdminObservations] POST error:", error);
    return NextResponse.json(
      { error: "Failed to perform action" },
      { status: 500 },
    );
  }
}
