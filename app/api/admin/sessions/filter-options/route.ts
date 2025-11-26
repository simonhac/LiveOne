import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { rawClient } from "@/lib/db";

export async function GET() {
  try {
    // Check if user is authenticated
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an admin
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Query systems table directly (9 rows) instead of scanning 118K sessions
    const systemNamesResult = await rawClient.execute(
      "SELECT display_name FROM systems ORDER BY display_name",
    );
    const vendorTypesResult = await rawClient.execute(
      "SELECT DISTINCT vendor_type FROM systems ORDER BY vendor_type",
    );

    const systemNames = systemNamesResult.rows.map(
      (r: any) => r.display_name as string,
    );
    const vendorTypes = vendorTypesResult.rows.map(
      (r: any) => r.vendor_type as string,
    );
    // Hardcoded - these are finite values defined in code
    const causes = ["ADMIN", "CRON", "POLL", "PUSH", "USER", "USER-TEST"];
    // Hardcoded - only 3 possible states: null=pending, true=success, false=failed
    const statuses: (boolean | null)[] = [null, true, false];

    return NextResponse.json({
      success: true,
      filterOptions: {
        systemName: systemNames,
        vendorType: vendorTypes,
        cause: causes,
        successful: statuses,
      },
    });
  } catch (error) {
    console.error("[API] Error fetching filter options:", error);
    return NextResponse.json(
      { error: "Failed to fetch filter options" },
      { status: 500 },
    );
  }
}
