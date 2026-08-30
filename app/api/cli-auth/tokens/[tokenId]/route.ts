/**
 * DELETE /api/cli-auth/tokens/{tokenId} — revoke one of the caller's own CLI tokens, or all of
 * them with `?all=true`.
 *
 * Only ever acts on the AUTHENTICATED user's records: `revoke` is keyed by `auth.userId`, never by
 * anything in the path, so a token id belonging to someone else simply revokes nothing.
 *
 * A token may revoke ITSELF (and `--all` includes it) — that is `auth logout`, and it is the right
 * capability for a credential to have over its own life.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { revoke } from "@/lib/cli-auth/store";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { tokenId } = await params;
  const all = new URL(request.url).searchParams.get("all") === "true";
  const revoked = await revoke(auth.userId, { id: tokenId, all });
  // 0 is a normal answer (already revoked, or not this user's token) — not an error, and
  // deliberately not distinguished, so this cannot be used to probe for another user's token ids.
  return NextResponse.json({ revoked });
}
