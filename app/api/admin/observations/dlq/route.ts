/**
 * Admin API for Observations Queue DLQ
 *
 * GET /api/admin/observations/dlq
 * Returns last 50 DLQ messages
 *
 * POST /api/admin/observations/dlq
 * Actions: retry-all
 */

import { NextResponse } from "next/server";
import { qstash, OBSERVATIONS_QUEUE_NAME } from "@/lib/qstash";

const LIMIT = 50;

interface DLQMessage {
  messageId: string;
  dlqId: string;
  topicName: string;
  url: string;
  body: string;
  createdAt: number;
  retried: number;
  maxRetries: number;
  responseStatus: number;
  responseBody: string;
}

export async function GET() {
  if (!qstash) {
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );
  }

  try {
    const dlqMessages = await qstash.dlq.listMessages({ count: LIMIT });
    const messages: DLQMessage[] = (dlqMessages.messages ?? []).map(
      (msg: any) => ({
        messageId: msg.messageId,
        dlqId: msg.dlqId,
        topicName: msg.topicName || "",
        url: msg.url || "",
        body: msg.body || "",
        createdAt: msg.createdAt || 0,
        retried: msg.retried || 0,
        maxRetries: msg.maxRetry || 3,
        responseStatus: msg.responseStatus || 0,
        responseBody: msg.responseBody || "",
      }),
    );

    return NextResponse.json({
      count: messages.length,
      messages,
    });
  } catch (error) {
    console.error("[AdminObservations] GET dlq error:", error);
    return NextResponse.json(
      { error: "Failed to get DLQ messages" },
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

    if (action !== "retry-all") {
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
    }

    const queue = qstash.queue({ queueName: OBSERVATIONS_QUEUE_NAME });
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
  } catch (error) {
    console.error("[AdminObservations] POST dlq error:", error);
    return NextResponse.json(
      { error: "Failed to retry DLQ messages" },
      { status: 500 },
    );
  }
}
