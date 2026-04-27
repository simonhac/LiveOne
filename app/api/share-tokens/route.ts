import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { createShareToken, listShareTokens } from "@/lib/share-tokens";

const ALLOWED_EXPIRY_DAYS = new Set([1, 7, 30, 90]);

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const tokens = await listShareTokens(auth.userId);
  return NextResponse.json({
    tokens: tokens.map((t) => ({
      token: t.token,
      label: t.label,
      createdAtMs: t.createdAtMs,
      expiresAtMs: t.expiresAtMs,
      revokedAtMs: t.revokedAtMs,
      lastUsedAtMs: t.lastUsedAtMs,
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}) as any);
  const expiresInDaysRaw = body?.expiresInDays;
  let expiresInDays: number | null = null;
  if (expiresInDaysRaw !== undefined && expiresInDaysRaw !== null) {
    if (!ALLOWED_EXPIRY_DAYS.has(expiresInDaysRaw)) {
      return NextResponse.json(
        {
          error: "Invalid expiresInDays",
          allowed: [...ALLOWED_EXPIRY_DAYS, null],
        },
        { status: 400 },
      );
    }
    expiresInDays = expiresInDaysRaw;
  }
  const label =
    typeof body?.label === "string" ? body.label.slice(0, 80) : null;

  const created = await createShareToken({
    ownerClerkUserId: auth.userId,
    expiresInDays,
    label,
  });
  return NextResponse.json(created, { status: 201 });
}
