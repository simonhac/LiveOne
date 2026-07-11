/**
 * SSE stream of the inspector view — pushes the full UsherView (source list + last-tick health +
 * each source's live snapshot) every 2 s. The fusher source's snapshot carries its 2 s power flow, so
 * the dashboard updates at the fast cadence even though pushes to gusher are minutely.
 */
import { NextRequest } from "next/server";
import { getUsherView } from "@/state/view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(getUsherView())}\n\n`),
          );
        } catch {
          /* controller closed */
        }
      };
      send();
      const timer = setInterval(send, 2000);
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
