/**
 * Calendar feed tokens for an area — mint, list, revoke.
 *
 *   GET    /api/v4/areas/[id]/calendar-tokens         → 200 { tokens: [...] }
 *   POST   /api/v4/areas/[id]/calendar-tokens         → 201 { token, urls }
 *   DELETE /api/v4/areas/[id]/calendar-tokens?token=… → 200 { revoked }
 *
 * Owner-or-admin via `loadAreaForOwner`, like every other area-scoped management route. The FEED
 * itself (`calendar.ics`) is the token-authenticated one; this route, which MINTS those tokens,
 * deliberately is not — a credential that could mint its own successor would never need renewing
 * and could never be fully revoked.
 */
import { NextRequest, NextResponse } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  listCalendarTokens,
  mintCalendarToken,
  revokeCalendarToken,
} from "@/lib/areas/calendar-tokens";

function unprocessable(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 422 });
}

/**
 * Both forms of the feed URL.
 *
 * `webcal://` is what makes a calendar client SUBSCRIBE (a repeating fetch) rather than import a
 * one-time snapshot, which is the whole point — and it is not a real scheme, just `https` spelled
 * so the OS hands the URL to the calendar app. The `https://` form is served alongside it for
 * anything that does not understand `webcal`, and for curl.
 */
function feedUrls(request: NextRequest, areaId: string, token: string) {
  const base = new URL(request.url);
  const path = `/api/v4/areas/${encodeURIComponent(areaId)}/calendar.ics?token=${token}`;
  return {
    https: `${base.origin}${path}`,
    webcal: `webcal://${base.host}${path}`,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const tokens = await listCalendarTokens(authed.area.id);
  return NextResponse.json({
    // Revoked and expired tokens are listed too, with their timestamps — "when did this stop
    // working" is the question a stale subscription raises, and a filtered list cannot answer it.
    tokens: tokens.map((t) => ({ ...t, ...feedUrls(request, id, t.token) })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  // Required, unlike a dashboard share token's: this URL is long-lived and unattended, and an
  // unlabelled one is a credential nobody can decide whether to revoke.
  if (label === "") return unprocessable("label is required");

  const expiresInDays = body?.expiresInDays;
  if (
    expiresInDays !== undefined &&
    expiresInDays !== null &&
    (typeof expiresInDays !== "number" ||
      !Number.isFinite(expiresInDays) ||
      expiresInDays <= 0)
  )
    return unprocessable("expiresInDays must be a positive number, or null");

  const row = await mintCalendarToken({
    areaUuid: authed.area.id,
    label,
    expiresInDays: (expiresInDays as number | null | undefined) ?? null,
  });
  return NextResponse.json(
    { token: { ...row, ...feedUrls(request, id, row.token) } },
    { status: 201 },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;

  const token = new URL(request.url).searchParams.get("token");
  if (!token) return unprocessable("token is required");

  // Scoped to the area the caller just proved they own — naming someone else's token revokes
  // nothing, and reports the same "already revoked or not yours" either way.
  const revoked = await revokeCalendarToken(authed.area.id, token);
  return NextResponse.json({ revoked });
}
