import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";

/**
 * GET /api/areas/candidate-systems — the real devices the caller may add as Area members (the area
 * builder's member picker). Exactly the systems visible to the user (owned ∪ granted ∪ public), which
 * is also the no-escalation set the create/add-member routes enforce.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const systems = await SystemsManager.getInstance().getSystemsVisibleByUser(
    auth.userId,
    true,
  );
  return NextResponse.json({ systems });
}
