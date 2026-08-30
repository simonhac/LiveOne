/**
 * POST /api/cli-auth/authorize — the approval half of the CLI browser hand-off.
 *
 * Clerk-gated (NOT in publicRoutes and NOT in isCliTokenRoute): the whole point is that the caller
 * proves who they are with a real browser session, which is what binds the resulting code to a
 * user. A CLI token cannot reach this route — a credential must not be able to mint its successor
 * without a fresh human approval.
 *
 * Returns a short-lived signed code. Nothing is stored: see lib/cli-auth/code.ts for why the code
 * is stateless and what the PKCE binding buys.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { mintCode, CODE_TTL_SECONDS } from "@/lib/cli-auth/code";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as {
    challenge?: unknown;
    label?: unknown;
  } | null;

  const challenge = typeof body?.challenge === "string" ? body.challenge : "";
  // base64url of a sha256 — 43 chars, no padding. Checked so a caller cannot park arbitrary text
  // in a signed blob.
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return NextResponse.json(
      { error: "challenge must be the base64url sha256 of a verifier" },
      { status: 400 },
    );

  const rawLabel = typeof body?.label === "string" ? body.label : "";
  // The label is echoed back in `auth list`; keep it short and printable rather than trusting it.
  const label = rawLabel.replace(/[^\w .@-]/g, "").slice(0, 64) || "cli";

  const secret = process.env.CLI_AUTH_SIGNING_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "CLI auth is not configured on this deployment" },
      { status: 503 },
    );

  return NextResponse.json({
    code: mintCode(
      { u: auth.userId, c: challenge, l: label },
      { secret, now: new Date() },
    ),
    expiresIn: CODE_TTL_SECONDS,
  });
}
