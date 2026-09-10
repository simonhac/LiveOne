import { NextRequest } from "next/server";
import { handleIntervals } from "@/lib/derivations/v4-routes";

/** GET /api/v4/derivations/{dx_}/intervals — the rows a derivation has produced. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dxid: string }> },
) {
  const { dxid } = await params;
  return handleIntervals(request, dxid);
}
