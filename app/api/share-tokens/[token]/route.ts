import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { isWellFormedToken, revokeShareToken } from "@/lib/share-tokens";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { token } = await params;
  if (!isWellFormedToken(token)) {
    return NextResponse.json(
      { error: "Invalid token format" },
      { status: 400 },
    );
  }

  const ok = await revokeShareToken(token, auth.userId);
  if (!ok) {
    return NextResponse.json(
      { error: "Token not found or already revoked" },
      { status: 404 },
    );
  }
  return NextResponse.json({ revoked: true });
}
