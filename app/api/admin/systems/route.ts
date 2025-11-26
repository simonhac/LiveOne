import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getAdminSystemsData } from "@/lib/admin/get-systems-data";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    // API always includes latest values (longer timeout - client can wait)
    const result = await getAdminSystemsData({ latestValuesTimeoutMs: 5000 });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching systems data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch systems data",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
