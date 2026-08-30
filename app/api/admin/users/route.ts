import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { listUserDirectory } from "@/lib/users/directory";

// The admin users table. The Clerk ⋈ owned-devices assembly lives in lib/users/directory.ts (shared
// with the v4 CLI routes); this route keeps its historical envelope around it verbatim.
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const usersData = await listUserDirectory();

    return NextResponse.json({
      success: true,
      users: usersData,
      totalUsers: usersData.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching users data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch users data",
      },
      { status: 500 },
    );
  }
}
