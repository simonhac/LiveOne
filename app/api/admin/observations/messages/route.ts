/**
 * Admin API for Observations Queue Pending Messages
 *
 * GET /api/admin/observations/messages
 * Returns last 50 pending messages from the queue
 */

import { NextResponse } from "next/server";
import { qstash, OBSERVATIONS_QUEUE_NAME } from "@/lib/qstash";
import { QueueMessage } from "@/lib/observations/types";

const LIMIT = 50;

interface PendingMessage {
  messageId: string;
  createdAt: number;
  retried: number;
  body: QueueMessage | null;
}

export async function GET() {
  if (!qstash) {
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );
  }

  try {
    const pendingMessages: PendingMessage[] = [];

    const events = await qstash.events({});
    const allEvents = events.events ?? [];

    // Find messageIds that have been terminated (delivered, cancelled, or failed to DLQ)
    const terminatedMessageIds = new Set<string>();
    for (const e of allEvents) {
      const event = e as any;
      if (
        event.queueName === OBSERVATIONS_QUEUE_NAME &&
        (event.state === "DELIVERED" ||
          event.state === "CANCELED" ||
          event.state === "ERROR")
      ) {
        terminatedMessageIds.add(event.messageId);
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
      .slice(0, LIMIT);

    for (const evt of queueEvents) {
      const event = evt as any;
      let body: QueueMessage | null = null;
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

    return NextResponse.json({ messages: pendingMessages });
  } catch (error) {
    console.error("[AdminObservations] GET messages error:", error);
    return NextResponse.json(
      { error: "Failed to get pending messages" },
      { status: 500 },
    );
  }
}
