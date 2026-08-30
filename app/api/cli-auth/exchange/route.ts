/**
 * POST /api/cli-auth/exchange — code + verifier → a CLI token.
 *
 * PUBLIC (listed in publicRoutes) because it is SELF-AUTHENTICATING: the code carries an HMAC this
 * server minted, and the verifier proves the caller is the process that started the flow. There is
 * no session here by design — the CLI has no cookie, which is the entire problem being solved.
 *
 * Every failure answers the same 400. The verifier distinguishes bad-signature from expired from
 * challenge-mismatch internally, and that distinction stays server-side: telling a caller which
 * half of a guess was wrong is an oracle.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyCode } from "@/lib/cli-auth/code";
import { issueToken } from "@/lib/cli-auth/store";

const REJECTED = { error: "invalid or expired authorization code" };

export async function POST(request: NextRequest) {
  const secret = process.env.CLI_AUTH_SIGNING_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "CLI auth is not configured on this deployment" },
      { status: 503 },
    );

  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
    verifier?: unknown;
  } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const verifier = typeof body?.verifier === "string" ? body.verifier : "";
  if (!code || !verifier) return NextResponse.json(REJECTED, { status: 400 });

  const result = verifyCode(code, verifier, { secret, now: new Date() });
  if (!result.ok) return NextResponse.json(REJECTED, { status: 400 });

  try {
    const { token, record } = await issueToken(result.payload.u, {
      label: result.payload.l,
    });
    // The secret is returned exactly once and never stored in plaintext anywhere.
    return NextResponse.json({
      token,
      tokenId: record.id,
      label: record.label,
      expiresAt: record.expiresAt,
    });
  } catch (err) {
    // The live-token cap is the expected failure here, and it IS actionable, so it is reported —
    // it says nothing about the credential, only about the account's own state.
    const message =
      err instanceof Error ? err.message : "could not issue a token";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
