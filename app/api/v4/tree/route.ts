import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { readTreeInventory } from "@/lib/inventory/read";

export const maxDuration = 120;
/** Read-only config inventory. Fleet scope is opt-in and comes exclusively from server auth. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const value = request.nextUrl.searchParams.get("sharing");
  if (value !== null && value !== "true" && value !== "false")
    return NextResponse.json(
      { error: "sharing must be true or false" },
      { status: 400 },
    );
  return NextResponse.json(
    await readTreeInventory(auth.userId, auth.actingAsAdmin, value === "true"),
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
