import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Wrap a QStash receiver handler with Upstash signature verification — but only when a signing key is
 * actually configured. QStash is OPTIONAL: dev/preview don't use it, and `lib/qstash.ts` already
 * degrades the publish `Client` to `null` when `OBSERVATIONS_QSTASH_TOKEN` is unset. The receiver side
 * lacked the same treatment: `verifySignatureAppRouter` THROWS at module-load time when
 * `currentSigningKey` is undefined (the `export const POST = verifySignatureAppRouter(...)` runs at
 * import), which breaks `next build` in any environment without the `OBSERVATIONS_QSTASH_*` secrets —
 * Next evaluates the route module during page-data collection.
 *
 * So: when the signing key is present (prod), verification is applied exactly as before. When it is
 * absent, we return a handler that 503s — the route stays importable everywhere, and we NEVER accept an
 * unverified request into the receiver (which writes to the serving store). Verification is still
 * mandatory wherever QStash is wired up.
 */
type QstashRouteHandler = (
  request: NextRequest | Request,
  params?: unknown,
) => Promise<Response>;

export function withQstashSignatureVerification(
  handler: (request: NextRequest) => Response | Promise<Response>,
): QstashRouteHandler {
  const currentSigningKey = process.env.OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey) {
    console.warn(
      "[observations] QStash signing key not configured — receiver disabled (returns 503). " +
        "Expected in dev/preview; in production set OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY.",
    );
    return async () =>
      NextResponse.json(
        { status: "error", error: "QStash receiver not configured" },
        { status: 503 },
      );
  }

  return verifySignatureAppRouter(handler, {
    currentSigningKey,
    nextSigningKey,
  });
}
